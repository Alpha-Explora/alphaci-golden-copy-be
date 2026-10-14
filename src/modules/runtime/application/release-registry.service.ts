import { createHash, randomBytes } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  APP_ROLE_LOOKUP,
  type AppRoleLookup,
} from '#kernel/ports/app-role.port';
import { canManageHosting } from '#kernel/rules/persona-access.rules';
import { canPromoteRelease } from '../domain/release-access.rules';
import { ENVIRONMENT_PROMOTE_WORKFLOW_FILE } from '#kernel/config/pipeline-branches';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  ENVIRONMENT_DEPLOYMENT_TARGET_RESOLVER,
  EnvironmentTargetUnavailableError,
  type DeploymentProjectReferenceLookup,
  type EnvironmentDeploymentTargetResolver,
} from '#kernel/ports/deployment-runtime.port';
import {
  COMMIT_SHA,
  SIGNATURE_ALGORITHMS,
  canonicalJson,
  manifestProblem,
  manifestSha256,
  parseImageReference,
  type ReleaseArtifact,
  type ReleaseManifest,
  type ReleaseSlot,
  type WorkflowRun,
} from '../domain/release-manifest';
import { verifyReleaseSignature } from '../domain/release-signature';
import type { DeploymentProvider } from '../core/deployment-provider.contract';
import { DeploymentProviderRegistry } from '../core/deployment-provider.registry';
import { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';
import {
  ReleaseRegistryRepository,
  allowedDeploymentTransitions,
  type DeploymentDelivery,
  type DeploymentStatus,
  type EnvironmentDeploymentRecord,
  type ReleaseRecord,
} from '../infrastructure/repositories/release-registry.repository';
import {
  GITHUB_ACTIONS_SECRETS,
  type GithubActionsSecretsPort,
} from './ports/github-actions-secrets.port';

export interface RegisterReleaseInput {
  projectId: string;
  repoFullName: string;
  sourceEnvironmentId: string;
  sourceBranch: string;
  commitSha: string;
  artifacts: Array<{ slot: ReleaseSlot; reference: string }>;
  workflowRun: WorkflowRun;
}

export interface SignedManifestInput {
  manifest: Record<string, unknown>;
  manifestSha256: string;
  signature: { algorithm: string; keyId: string; value: string };
}

export interface ReleaseRegistryView {
  releaseId: string;
  projectId: string;
  sourceEnvironmentId: string;
  sourceBranch: string;
  commitSha: string;
  artifacts: ReleaseArtifact[];
  workflowRun: WorkflowRun;
  verificationStatus: 'pending' | 'verified';
  manifestSha256: string | null;
  createdAt: string;
  deployments: EnvironmentDeploymentRecord[];
}

const HOST_TOKEN_PREFIX = 'aoh_';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Immutable releases and explicit promotion between ordered environments.
 *
 * CI registers a release once, for the project's first environment, which is
 * the only environment that deploys automatically. Every later environment
 * receives a release only through a signed-in promotion, and only the release
 * the preceding environment currently runs. CI tokens register, sign, and
 * report; they cannot promote. On-prem hosts pull their own environment's
 * assignments with a host token and report status.
 *
 * Each deployment is delivered one way, fixed when it is created: by the
 * generated workflow, which CI reports, or by the environment's host, which
 * the host reports. The environment's targets decide, and must agree.
 */
@Injectable()
export class ReleaseRegistryService {
  constructor(
    private readonly releases: ReleaseRegistryRepository,
    private readonly deploymentTargets: DeploymentTargetsRepository,
    @Inject(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP)
    private readonly projects: DeploymentProjectReferenceLookup,
    @Inject(ENVIRONMENT_DEPLOYMENT_TARGET_RESOLVER)
    private readonly targets: EnvironmentDeploymentTargetResolver,
    private readonly configService: ConfigService,
    private readonly providerRegistry: DeploymentProviderRegistry<DeploymentProvider>,
    @Optional()
    @Inject(APP_ROLE_LOOKUP)
    private readonly appRoleLookup?: AppRoleLookup,
    @Optional()
    @Inject(GITHUB_ACTIONS_SECRETS)
    private readonly githubActions?: GithubActionsSecretsPort,
  ) {}

  async registerRelease(
    input: RegisterReleaseInput,
  ): Promise<ReleaseRegistryView> {
    this.assertReleasesEnabled();
    if (!COMMIT_SHA.test(input.commitSha)) {
      throw new BadRequestException(
        'commitSha must be the full 40-character commit SHA',
      );
    }
    if (input.workflowRun.repo !== input.repoFullName) {
      throw new BadRequestException(
        'workflowRun.repo must be the authorized repository',
      );
    }
    const environments = await this.projects.listProjectEnvironments(
      input.projectId,
    );
    const source = environments.find(
      ({ id }) => id === input.sourceEnvironmentId,
    );
    if (!source) throw new NotFoundException('Environment not found');
    if (source.position !== 0) {
      throw new BadRequestException(
        'Only the first environment registers releases; later environments receive them by promotion.',
      );
    }
    if (input.sourceBranch !== source.sourceBranch) {
      throw new BadRequestException(
        'sourceBranch must be the first environment source branch (' +
          source.sourceBranch +
          ').',
      );
    }

    const artifacts: ReleaseArtifact[] = [];
    for (const artifact of input.artifacts) {
      const parsed = parseImageReference(artifact.reference);
      if (!parsed) {
        throw new BadRequestException(
          'Artifact ' +
            artifact.slot +
            ' must be image@sha256:<64 hex>; tags are refused.',
        );
      }
      if (artifacts.some(({ slot }) => slot === artifact.slot)) {
        throw new BadRequestException('Each slot may carry one artifact.');
      }
      artifacts.push({ slot: artifact.slot, ...parsed });
    }

    const sourceTargets = await this.deploymentTargets.listDeploymentTargets(
      input.projectId,
      source.id,
    );
    if (sourceTargets.length === 0) {
      throw new ConflictException(
        'The first environment has no deployment target.',
      );
    }
    for (const artifact of artifacts) {
      await this.resolveTarget(input.projectId, source.id, artifact.slot);
    }
    const automaticDelivery = this.deliveryOf(sourceTargets, source.slug);

    try {
      const release = await this.releases.registerRelease({
        projectId: input.projectId,
        sourceEnvironmentId: source.id,
        sourceBranch: source.sourceBranch,
        commitSha: input.commitSha,
        workflowRun: input.workflowRun,
        artifacts,
        automaticTargetIds: sourceTargets.map(({ id }) => id),
        automaticDelivery,
      });
      return this.view(release);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'A release is already registered for this workflow run, or the first environment is still deploying one.',
        );
      }
      throw error;
    }
  }

  async getRelease(
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRegistryView> {
    this.assertReleasesEnabled();
    return this.view(await this.requireRelease(projectId, releaseId));
  }

  /** Attach the CI-signed manifest. The backend recomputes its canonical hash. */
  async attachManifest(
    projectId: string,
    releaseId: string,
    input: SignedManifestInput,
  ): Promise<ReleaseRegistryView> {
    this.assertReleasesEnabled();
    const release = await this.requireRelease(projectId, releaseId);
    const problem = manifestProblem(input.manifest, {
      releaseId: release.id,
      projectId: release.projectId,
      sourceEnvironmentId: release.sourceEnvironmentId,
      sourceBranch: release.sourceBranch,
      commitSha: release.commitSha,
      artifacts: release.artifacts,
      workflowRun: release.workflowRun,
    });
    if (problem) throw new BadRequestException('Invalid manifest: ' + problem);
    const computed = manifestSha256(input.manifest);
    if (computed !== input.manifestSha256) {
      throw new BadRequestException(
        'manifestSha256 does not match the canonical manifest.',
      );
    }
    if (
      !(SIGNATURE_ALGORITHMS as readonly string[]).includes(
        input.signature.algorithm,
      )
    ) {
      throw new BadRequestException(
        'signature.algorithm must be one of ' +
          SIGNATURE_ALGORITHMS.join(', ') +
          '.',
      );
    }
    if (
      !input.signature.keyId.trim() ||
      input.signature.keyId !== input.signature.keyId.trim()
    ) {
      throw new BadRequestException(
        'signature.keyId must name a trusted release-signing key.',
      );
    }
    const verification = verifyReleaseSignature({
      algorithm: input.signature.algorithm,
      keyId: input.signature.keyId,
      value: input.signature.value,
      canonicalManifest: canonicalJson(input.manifest),
      trustedKeysJson: this.configService.get<string>(
        'ALPHACI_RELEASE_TRUST_KEYS_JSON',
      ),
    });
    if (!verification.valid) {
      if (
        verification.reason === 'trust_keys_unconfigured' ||
        verification.reason === 'unknown_key'
      ) {
        throw new ForbiddenException(
          'The release signature key is not trusted by this AlphaCI deployment.',
        );
      }
      if (verification.reason === 'invalid_trust_keys') {
        throw new ServiceUnavailableException(
          'The release-signing trust keys are not configured correctly.',
        );
      }
      throw new BadRequestException(
        'The release signature is invalid for the canonical manifest.',
      );
    }

    if (release.verificationStatus === 'verified') {
      if (
        release.manifestSha256 === computed &&
        release.signature?.value === input.signature.value &&
        release.signature.keyId === input.signature.keyId
      ) {
        return this.view(release);
      }
      throw new ConflictException(
        'This release already has a different signed manifest.',
      );
    }
    const stored = await this.releases.attachManifest({
      releaseId: release.id,
      manifest: input.manifest as unknown as ReleaseManifest,
      manifestSha256: computed,
      signature: input.signature,
    });
    if (!stored)
      throw new ConflictException(
        'The release was signed concurrently. Reload it.',
      );
    return this.view(await this.requireRelease(projectId, releaseId));
  }

  /** CI reports the automatic deployment of the first environment. */
  async reportAutomaticDeployment(
    projectId: string,
    releaseId: string,
    status: DeploymentStatus,
    detail: string | null,
  ): Promise<EnvironmentDeploymentRecord> {
    this.assertReleasesEnabled();
    await this.requireRelease(projectId, releaseId);
    const deployment = await this.releases.findAutomaticDeployment(releaseId);
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertWorkflowDelivered(deployment);
    return this.transition(deployment, status, detail);
  }

  /** CI reports a promoted deployment it is running for its own project. */
  async reportPromotionDeployment(
    projectId: string,
    deploymentId: string,
    status: DeploymentStatus,
    detail: string | null,
  ): Promise<EnvironmentDeploymentRecord> {
    this.assertReleasesEnabled();
    const deployment = await this.releases.findDeployment(deploymentId);
    if (
      !deployment ||
      deployment.projectId !== projectId ||
      deployment.trigger !== 'promotion'
    ) {
      throw new NotFoundException('Deployment not found');
    }
    this.assertWorkflowDelivered(deployment);
    return this.transition(deployment, status, detail);
  }

  /** Deploy a release to the next ordered environment, on behalf of a signed-in user. */
  async promote(input: {
    projectId: string;
    environmentId: string;
    releaseId: string;
    userId: string;
  }): Promise<EnvironmentDeploymentRecord> {
    this.assertReleasesEnabled();
    const project = await this.projects.findProjectReference(
      input.projectId,
      input.userId,
    );
    if (!project) throw new NotFoundException('Project not found');
    const environments = await this.projects.listProjectEnvironments(
      input.projectId,
    );
    const destination = environments.find(
      ({ id }) => id === input.environmentId,
    );
    if (!destination) throw new NotFoundException('Environment not found');
    const role = await this.appRoleLookup?.findAppRole(input.userId);
    if (!canPromoteRelease(role, destination.role)) {
      throw new ForbiddenException(
        'Your role cannot promote a release to this environment.',
      );
    }
    if (destination.position === 0) {
      throw new BadRequestException(
        'The first environment deploys automatically; promote to a later environment.',
      );
    }
    const previous = environments.find(
      ({ position }) => position === destination.position - 1,
    );
    if (!previous)
      throw new ConflictException('The environment order is incomplete.');

    const release = await this.requireRelease(input.projectId, input.releaseId);
    if (release.verificationStatus !== 'verified') {
      throw new ConflictException(
        'The release has no signed manifest, so it cannot be promoted.',
      );
    }
    if ((await this.releases.pinnedReleaseId(previous.id)) !== release.id) {
      throw new ConflictException(
        'Only the release ' +
          previous.slug +
          ' currently runs can be promoted to ' +
          destination.slug +
          '.',
      );
    }

    const slots = [
      ...new Set(
        (
          await this.deploymentTargets.listDeploymentTargets(
            input.projectId,
            release.sourceEnvironmentId,
          )
        ).map(({ slot }) => slot),
      ),
    ];
    const destinationTargets: Array<{ id: string; provider: string }> = [];
    for (const slot of slots) {
      destinationTargets.push(
        await this.resolveTarget(input.projectId, destination.id, slot),
      );
    }
    const delivery = this.deliveryOf(destinationTargets, destination.slug);

    let deployment: EnvironmentDeploymentRecord;
    try {
      deployment = await this.releases.createPromotion({
        projectId: input.projectId,
        environmentId: destination.id,
        releaseId: release.id,
        targetIds: destinationTargets.map(({ id }) => id),
        delivery,
        requestedBy: input.userId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          destination.slug + ' is already deploying a release.',
        );
      }
      throw error;
    }

    // A host-delivered environment's host picks the assignment up itself.
    if (delivery === 'workflow') {
      await this.dispatchPromotion(
        project.repoFullName,
        input.userId,
        release,
        deployment,
      );
    }
    return deployment;
  }

  /**
   * Start the generated promotion workflow for a managed destination. If
   * GitHub refuses, the deployment is failed rather than left pending forever.
   */
  private async dispatchPromotion(
    repoFullName: string,
    userId: string,
    release: ReleaseRecord,
    deployment: EnvironmentDeploymentRecord,
  ): Promise<void> {
    try {
      if (!this.githubActions) {
        throw new Error('GitHub workflow dispatch is not configured');
      }
      await this.githubActions.dispatchWorkflow({
        userId,
        repoFullName,
        workflowFile: ENVIRONMENT_PROMOTE_WORKFLOW_FILE,
        ref: release.sourceBranch,
        inputs: {
          'release-id': release.id,
          'deployment-id': deployment.id,
          'environment-id': deployment.environmentId,
        },
      });
    } catch (error) {
      await this.releases.transitionDeployment({
        deploymentId: deployment.id,
        from: 'pending',
        to: 'failed',
        detail: ('Promotion workflow dispatch failed: ' + String(error)).slice(
          0,
          2000,
        ),
      });
      throw new BadGatewayException(
        'The promotion workflow could not be started, so the deployment was marked failed.',
      );
    }
  }

  /** Releases of a project the user can see, newest first. */
  async listProjectReleases(
    projectId: string,
    userId: string,
  ): Promise<ReleaseRegistryView[]> {
    this.assertReleasesEnabled();
    const project = await this.projects.findProjectReference(projectId, userId);
    if (!project) throw new NotFoundException('Project not found');
    const releases = await this.releases.listProjectReleases(projectId, 50);
    return Promise.all(releases.map((release) => this.view(release)));
  }

  /** Deployment history of one environment the user can see, newest first. */
  async listEnvironmentDeployments(
    projectId: string,
    environmentId: string,
    userId: string,
  ): Promise<EnvironmentDeploymentRecord[]> {
    this.assertReleasesEnabled();
    const project = await this.projects.findProjectReference(projectId, userId);
    if (!project) throw new NotFoundException('Project not found');
    const environment = await this.projects.findProjectEnvironment(
      projectId,
      environmentId,
    );
    if (!environment) throw new NotFoundException('Environment not found');
    return this.releases.listEnvironmentDeployments(environment.id, 100);
  }

  /** Register an on-prem host for one environment; the token is shown once. */
  async createHost(input: {
    projectId: string;
    environmentId: string;
    userId: string;
    name: string;
  }) {
    this.assertOnpremEnabled();
    const project = await this.projects.findProjectReference(
      input.projectId,
      input.userId,
    );
    if (!project) throw new NotFoundException('Project not found');
    const role = await this.appRoleLookup?.findAppRole(input.userId);
    if (!canManageHosting(role)) {
      throw new ForbiddenException(
        'Only Developers and admins can register hosting.',
      );
    }
    const environment = await this.projects.findProjectEnvironment(
      input.projectId,
      input.environmentId,
    );
    if (!environment) throw new NotFoundException('Environment not found');
    const token = HOST_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const host = await this.releases.createHost({
      projectId: input.projectId,
      environmentId: environment.id,
      name: input.name.trim(),
      tokenPrefix: token.slice(0, 12),
      tokenSha256: sha256(token),
      createdBy: input.userId,
    });
    return { ...host, token };
  }

  /** What a host must deploy: its environment's in-flight, signed deployments. */
  async hostAssignments(token: string) {
    const host = await this.requireHost(token);
    const assignments = await this.releases.listHostAssignments(
      host.environmentId,
    );
    return assignments.map(({ deployment, release }) => ({
      deploymentId: deployment.id,
      status: deployment.status,
      assignment: {
        projectId: deployment.projectId,
        environmentId: deployment.environmentId,
        targetIds: deployment.targetIds,
      },
      envelope: {
        manifest: release.manifest,
        manifestSha256: release.manifestSha256,
        signature: release.signature,
      },
    }));
  }

  async reportHostStatus(
    token: string,
    deploymentId: string,
    status: DeploymentStatus,
    detail: string | null,
  ): Promise<EnvironmentDeploymentRecord> {
    const host = await this.requireHost(token);
    const deployment = await this.releases.findDeployment(deploymentId);
    if (
      !deployment ||
      deployment.environmentId !== host.environmentId ||
      deployment.delivery !== 'host'
    ) {
      throw new NotFoundException('Deployment not found');
    }
    return this.transition(deployment, status, detail);
  }

  /** How an environment's targets are delivered. Mixing the two is refused. */
  private deliveryOf(
    targets: ReadonlyArray<{ provider: string }>,
    environmentSlug: string,
  ): DeploymentDelivery {
    const deliveries = new Set(
      targets.map(({ provider }) =>
        this.providerRegistry.find(provider)?.capabilities.connectivity ===
        'indirect'
          ? 'host'
          : 'workflow',
      ),
    );
    if (deliveries.size > 1) {
      throw new ConflictException(
        environmentSlug +
          ' has both on-prem and hosted targets; every target in an environment must be delivered the same way.',
      );
    }
    return deliveries.has('host') ? 'host' : 'workflow';
  }

  private assertWorkflowDelivered(
    deployment: EnvironmentDeploymentRecord,
  ): void {
    if (deployment.delivery === 'host') {
      throw new ConflictException(
        "This deployment runs on the environment's on-prem host, which reports its status.",
      );
    }
  }

  private async transition(
    deployment: EnvironmentDeploymentRecord,
    status: DeploymentStatus,
    detail: string | null,
  ): Promise<EnvironmentDeploymentRecord> {
    if (deployment.status === status) return deployment;
    if (!allowedDeploymentTransitions(deployment.status).includes(status)) {
      throw new ConflictException(
        'A ' + deployment.status + ' deployment cannot become ' + status + '.',
      );
    }
    const moved = await this.releases.transitionDeployment({
      deploymentId: deployment.id,
      from: deployment.status,
      to: status,
      detail,
    });
    if (!moved)
      throw new ConflictException(
        'The deployment changed concurrently. Reload it.',
      );
    return moved;
  }

  private async resolveTarget(
    projectId: string,
    environmentId: string,
    slot: ReleaseSlot,
  ) {
    try {
      return await this.targets.resolve({ projectId, environmentId, slot });
    } catch (error) {
      if (error instanceof EnvironmentTargetUnavailableError) {
        throw new ConflictException(error.message + ' (' + slot + ')');
      }
      throw error;
    }
  }

  private async requireRelease(
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord> {
    const release = await this.releases.findRelease(projectId, releaseId);
    if (!release) throw new NotFoundException('Unknown release');
    return release;
  }

  private async requireHost(token: string) {
    this.assertOnpremEnabled();
    const host = token.startsWith(HOST_TOKEN_PREFIX)
      ? await this.releases.findActiveHostByTokenHash(sha256(token))
      : null;
    if (!host)
      throw new UnauthorizedException('A valid host token is required');
    return host;
  }

  private async view(release: ReleaseRecord): Promise<ReleaseRegistryView> {
    return {
      releaseId: release.id,
      projectId: release.projectId,
      sourceEnvironmentId: release.sourceEnvironmentId,
      sourceBranch: release.sourceBranch,
      commitSha: release.commitSha,
      artifacts: release.artifacts,
      workflowRun: release.workflowRun,
      verificationStatus: release.verificationStatus,
      manifestSha256: release.manifestSha256,
      createdAt: release.createdAt,
      deployments: await this.releases.listReleaseDeployments(release.id),
    };
  }

  private assertReleasesEnabled(): void {
    if (
      !this.configService.getOrThrow<AppConfig>('app').envProvisioning.enabled
    ) {
      throw new ServiceUnavailableException(
        'Deployment provisioning is disabled in this deployment, so releases are not available.',
      );
    }
  }

  /** On-prem hosts stay unreachable until this deployment turns them on. */
  private assertOnpremEnabled(): void {
    this.assertReleasesEnabled();
    if (this.configService.get<string>('ONPREM_RELEASES_ENABLED') !== 'true') {
      throw new NotFoundException();
    }
  }
}
