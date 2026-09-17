import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import type { DeploymentTargetSummary } from '../core/deployments.types';
import { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';
import {
  PROVIDER_RELEASER_REGISTRY,
  type ProviderReleaseHandle,
  type ProviderReleaserRegistryPort,
} from './ports/provider-releaser.port';

export interface StartReleaseInput {
  projectId: string;
  slot: string;
  branch: string;
  commitSha: string;
  artifact?: string | undefined;
  runUrl?: string | undefined;
}

export interface ReleaseView {
  releaseId: string;
  status: ProviderReleaseHandle['status'];
  serviceUrl: string | null;
  healthcheckUrl: string | null;
  message: string | null;
}

/** Separates the two opaque halves of a release id. */
const RELEASE_ID_SEPARATOR = '.';

/**
 * Releases what a pipeline built, to the target that project uses for that
 * slot and branch.
 *
 * The pipeline knows what it built; this knows where it goes. That split is
 * the point: a generated workflow names no host and carries no hosting
 * credential, so adding a provider is a change here rather than a change to
 * every customer's repository.
 *
 * The release id is `<deploymentTargetId>.<providerReleaseId>` rather than a
 * stored row. A release is finished within minutes and the poller is the same
 * job that started it, so persisting one would add a table, a migration and a
 * cleanup policy to remember something nothing outlives the run to read.
 */
@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    // The Runtime repository, not the cross-context query port: the port's
    // summary is the serialisable shape other contexts read, while a releaser
    // needs the provider-typed one this context owns.
    private readonly deploymentTargets: DeploymentTargetsRepository,
    @Inject(PROVIDER_RELEASER_REGISTRY)
    private readonly releasers: ProviderReleaserRegistryPort,
    private readonly configService: ConfigService,
  ) {}

  async startRelease(input: StartReleaseInput): Promise<ReleaseView> {
    this.assertEnabled();

    const target = await this.findTarget(input);
    const releaser = this.releaserFor(target);

    this.logger.log(
      `Releasing ${target.provider}/${target.slot} ${input.branch} for project ${input.projectId} at ${input.commitSha}`,
    );

    const handle = await releaser.start({
      target,
      branch: input.branch,
      commitSha: input.commitSha,
      ...(input.artifact ? { artifact: input.artifact } : {}),
    });

    return this.toView(target, handle);
  }

  async getRelease(input: {
    projectId: string;
    releaseId: string;
  }): Promise<ReleaseView> {
    this.assertEnabled();

    const separator = input.releaseId.indexOf(RELEASE_ID_SEPARATOR);
    if (separator <= 0 || separator === input.releaseId.length - 1) {
      throw new NotFoundException('Unknown release');
    }

    const targetId = input.releaseId.slice(0, separator);
    const providerReleaseId = input.releaseId.slice(separator + 1);

    // Scoped to the project the token authenticated, so a token cannot read a
    // release belonging to someone else's target.
    const targets = await this.deploymentTargets.listDeploymentTargets(
      input.projectId,
    );
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) {
      throw new NotFoundException('Unknown release');
    }

    const releaser = this.releaserFor(target);
    const handle = await releaser.check({ target, providerReleaseId });
    return this.toView(target, handle);
  }

  private async findTarget(
    input: StartReleaseInput,
  ): Promise<DeploymentTargetSummary> {
    const targets = await this.deploymentTargets.listDeploymentTargets(
      input.projectId,
    );
    const slot = input.slot.trim();
    const branch = input.branch.trim();

    const target = targets.find(
      (candidate) =>
        candidate.slot === slot && (candidate.branchName ?? '') === branch,
    );

    if (!target) {
      // Naming what does exist: the usual cause is a branch with no service,
      // and "no target" alone leaves the reader unable to tell that apart from
      // a project with no hosting at all.
      const available = targets
        .map(
          (candidate) => `${candidate.slot}/${candidate.branchName ?? 'none'}`,
        )
        .join(', ');
      throw new NotFoundException(
        `This project has no ${slot} deployment target for '${branch}'.` +
          (available ? ` It has: ${available}.` : ' It has none at all.'),
      );
    }

    return target;
  }

  private releaserFor(target: DeploymentTargetSummary) {
    const releaser = this.releasers.get(target.provider);
    if (!releaser) {
      throw new BadRequestException(
        `${target.provider} deployments are performed by the pipeline itself, so there is nothing to release here.`,
      );
    }

    if (!releaser.supports(target)) {
      throw new BadRequestException(
        `The ${target.provider} releaser does not handle this target ` +
          `(strategy '${target.deploymentStrategy}', ownership '${target.ownershipMode}').`,
      );
    }

    return releaser;
  }

  private toView(
    target: DeploymentTargetSummary,
    handle: ProviderReleaseHandle,
  ): ReleaseView {
    const serviceUrl = handle.serviceUrl ?? null;
    return {
      releaseId: `${target.id}${RELEASE_ID_SEPARATOR}${handle.providerReleaseId}`,
      status: handle.status,
      serviceUrl,
      // The pipeline appends its own health path to a bare origin; a provider
      // that knows a full health URL can return one later without a contract
      // change.
      healthcheckUrl: null,
      message: handle.message ?? null,
    };
  }

  private assertEnabled(): void {
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (!config.envProvisioning.enabled) {
      throw new ServiceUnavailableException(
        'Deployment provisioning is disabled in this deployment, so releases are not available.',
      );
    }
  }
}
