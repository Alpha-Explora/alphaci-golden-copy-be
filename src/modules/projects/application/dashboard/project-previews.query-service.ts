import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import {
  DEPLOYMENT_HISTORY_QUERY,
  type DeploymentEnvironment,
  type DeploymentHistoryItem,
  type DeploymentHistoryQuery,
  type DeploymentProjectReference,
} from '#kernel/ports/deployment-runtime.port';
import {
  DEPLOYMENT_PROVIDER_CATALOG,
  type DeploymentProviderCatalogEntry,
  type DeploymentProviderCatalogPort,
} from '#kernel/ports/deployment-provider-catalog.port';
import { resolvePreviewSurface } from '../../domain/preview-surface.rule';
import type {
  ProjectBranchPreview,
  ProjectPreviewsResponse,
} from './project-previews.types';
import { UrlEmbeddabilityProbe } from './url-embeddability.probe';

@Injectable()
export class ProjectPreviewsService {
  constructor(
    @Inject(DEPLOYMENT_HISTORY_QUERY)
    private readonly deploymentsService: DeploymentHistoryQuery,
    private readonly embeddabilityProbe: UrlEmbeddabilityProbe,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
    // Optional so a composition root that has not wired the catalog (e.g. an
    // older test harness) still gets a working service - every branch just
    // falls back to the page surface, which is what happened before this
    // port field existed.
    @Optional()
    @Inject(DEPLOYMENT_PROVIDER_CATALOG)
    private readonly providerCatalog?: DeploymentProviderCatalogPort,
  ) {}

  /**
   * Per-branch previews, newest deployment per branch.
   *
   * Deliberately built on top of ProjectDeploymentsService rather than issuing
   * its own provider calls: the deployment history and this view want the same
   * upstream data, and Vercel's API is rate limited, so a second independent
   * fetch would double the request count for the same screen.
   */
  async listPreviews(
    project: DeploymentProjectReference,
  ): Promise<ProjectPreviewsResponse> {
    if (!this.enabled()) {
      return {
        enabled: false,
        liveProvidersEnabled: false,
        branches: [],
        providerError: null,
      };
    }

    const [history, environments] = await Promise.all([
      this.deploymentsService.listDeployments(project),
      this.listEnvironments(project),
    ]);

    // A branch's stable address, where its environment has one. It is what
    // the provider lists as the branch's domain and what stays reachable: on
    // Vercel a deployment's own hostname sits behind deployment protection,
    // while the production domain is public.
    const stableUrls = new Map(
      environments.map((environment) => [
        `${environment.targetId}::${environment.branch}`,
        environment.url,
      ]),
    );

    const isProduction = productionBranchRule(environments);
    const newestPerBranch = this.newestPerBranch(history.deployments);
    const branches = await Promise.all(
      newestPerBranch.map((deployment) =>
        this.toBranchPreview(
          deployment,
          stableUrls.get(`${deployment.targetId}::${deployment.branch}`) ??
            null,
          isProduction(deployment),
        ),
      ),
    );

    /*
     * Environments with nothing deployed to them yet.
     *
     * Without these, a project provisioned an hour ago shows an empty panel
     * and the words "no branch has been deployed" - true, and useless. Its uat
     * and main environments already exist, with addresses provisioning chose,
     * and the reader wants to see them before the first release rather than
     * after. Shown alongside the deployed ones, marked for what they are.
     *
     * Deployments win where both exist: a branch that HAS a deployment is
     * described by it, and only the leftovers are filled in.
     */
    const deployed = new Set(
      branches.map((preview) => `${preview.targetId}::${preview.branch}`),
    );
    const pending = environments
      .filter(
        (environment) =>
          !deployed.has(`${environment.targetId}::${environment.branch}`),
      )
      .map((environment) =>
        toPendingPreview(
          environment,
          this.logsAvailable(environment.provider),
          this.providerLabel(environment.provider),
        ),
      );

    return {
      enabled: true,
      liveProvidersEnabled: history.liveProvidersEnabled,
      // Production first, then the most recently deployed branch, so the
      // branch someone just pushed surfaces near the top. Environments with no
      // deployment sort last within their tier - they have no date to rank by
      // and nothing has happened to them.
      branches: [...branches, ...pending].sort(comparePreviews),
      providerError: history.providerError,
    };
  }

  /**
   * Optional on the port, so an implementation that cannot enumerate
   * environments simply contributes none and the panel falls back to history.
   */
  private async listEnvironments(
    project: DeploymentProjectReference,
  ): Promise<DeploymentEnvironment[]> {
    return (await this.deploymentsService.listEnvironments?.(project)) ?? [];
  }

  /**
   * One entry per (target, branch) pair. Two targets can deploy the same
   * branch — a frontend and a backend slot on the same repo — and those are
   * genuinely different previews, so the target is part of the key.
   */
  private newestPerBranch(
    deployments: DeploymentHistoryItem[],
  ): DeploymentHistoryItem[] {
    const newest = new Map<string, DeploymentHistoryItem>();

    for (const deployment of deployments) {
      if (!deployment.branch) {
        // Without a branch there is nothing to group under; it still shows in
        // the deployment history, just not here.
        continue;
      }

      const key = `${deployment.targetId}::${deployment.branch}`;
      const existing = newest.get(key);
      if (!existing || isNewer(deployment, existing)) {
        newest.set(key, deployment);
      }
    }

    return [...newest.values()];
  }

  private async toBranchPreview(
    deployment: DeploymentHistoryItem,
    stableUrl: string | null,
    isProduction: boolean,
  ): Promise<ProjectBranchPreview> {
    const previewUrl = stableUrl ?? deployment.deploymentUrl;
    const logsAvailable = this.logsAvailable(deployment.provider);
    const surface = resolvePreviewSurface(deployment.slot, logsAvailable);
    const verdict = await this.resolveEmbedVerdict(
      surface,
      deployment.status,
      previewUrl,
    );

    return {
      branch: deployment.branch as string,
      isProduction,
      deploymentId: deployment.id,
      targetId: deployment.targetId,
      targetName: deployment.targetName,
      provider: deployment.provider,
      slot: deployment.slot,
      surface,
      providerLabel: this.providerLabel(deployment.provider),
      logsAvailable,
      // The current deployment IS the branch's newest one (see newestPerBranch
      // above), so its window is always open-ended: tail from when it started
      // to now.
      logWindow: { startTime: deployment.createdAt, endTime: null },
      status: deployment.status,
      commitSha: deployment.commitSha,
      commitMessage: deployment.commitMessage,
      pullRequestNumber: deployment.pullRequestNumber,
      createdBy: deployment.createdBy,
      previewUrl,
      deploymentUrl: deployment.deploymentUrl,
      inspectorUrl: deployment.inspectorUrl,
      createdAt: deployment.createdAt,
      readyAt: deployment.readyAt,
      embeddable: verdict.embeddable,
      embedBlockedReason: verdict.reason,
    };
  }

  /**
   * A 'logs' surface never frames a page, so it never probes one either -
   * probing would spend a provider request (and, on Render's free tier, wake
   * a sleeping instance) to learn something the card will not use. Framing
   * otherwise only makes sense for something that finished building.
   */
  private async resolveEmbedVerdict(
    surface: ReturnType<typeof resolvePreviewSurface>,
    status: DeploymentHistoryItem['status'],
    previewUrl: string | null,
  ): Promise<{ embeddable: boolean | null; reason: string | null }> {
    if (surface === 'logs') {
      return { embeddable: false, reason: null };
    }
    if (status !== 'ready') {
      return { embeddable: null, reason: null };
    }
    return this.embeddabilityProbe.check(previewUrl);
  }

  private catalogEntry(
    provider: string,
  ): DeploymentProviderCatalogEntry | undefined {
    return this.providerCatalog?.list().find((entry) => entry.id === provider);
  }

  private providerLabel(provider: string): string {
    return this.catalogEntry(provider)?.label ?? provider;
  }

  private logsAvailable(provider: string): boolean {
    return this.catalogEntry(provider)?.logs ?? false;
  }

  private enabled(): boolean {
    return (
      this.capabilityResolver
        ?.deployment()
        .has('runtime.preview-deployments') ?? false
    );
  }
}

/**
 * Whether a deployment is its target's production environment.
 *
 * The provider's own label is not enough: Vercel reports the deploy target,
 * and the platform deploys every branch through the production target, so a
 * failed build of a feature branch came back as production and the Overview
 * drew it as a second Production Deployment card. A target whose production
 * environment is known answers by branch - only a deployment of that
 * environment's branch is production. A target with no environment listed
 * (a provider that cannot enumerate them) keeps the label, the one signal
 * there is.
 */
function productionBranchRule(
  environments: DeploymentEnvironment[],
): (deployment: DeploymentHistoryItem) => boolean {
  const productionBranches = new Map<string, Set<string>>();
  for (const environment of environments) {
    if (environment.environment !== 'production') continue;
    const branches =
      productionBranches.get(environment.targetId) ?? new Set<string>();
    branches.add(environment.branch);
    productionBranches.set(environment.targetId, branches);
  }

  return (deployment) => {
    const branches = productionBranches.get(deployment.targetId);
    if (!branches) return deployment.environment === 'production';
    return deployment.branch !== null && branches.has(deployment.branch);
  };
}

function isNewer(
  candidate: DeploymentHistoryItem,
  incumbent: DeploymentHistoryItem,
): boolean {
  return Date.parse(candidate.createdAt) > Date.parse(incumbent.createdAt);
}

/** An environment that exists but has never been released to. */
function toPendingPreview(
  environment: DeploymentEnvironment,
  logsAvailable: boolean,
  providerLabel: string,
): ProjectBranchPreview {
  return {
    branch: environment.branch,
    isProduction: environment.environment === 'production',
    deploymentId: null,
    targetId: environment.targetId,
    targetName: environment.targetName,
    provider: environment.provider,
    slot: environment.slot,
    surface: resolvePreviewSurface(environment.slot, logsAvailable),
    providerLabel,
    logsAvailable,
    // Nothing has been released here yet, so there is no deploy to tail.
    logWindow: null,
    status: 'not_deployed',
    commitSha: null,
    commitMessage: null,
    pullRequestNumber: null,
    createdBy: null,
    deploymentUrl: null,
    // The address it will answer on. Shown, not linked: until something is
    // released there it resolves to nothing, and a link that 404s reads as a
    // broken deployment rather than an empty one.
    previewUrl: environment.url,
    inspectorUrl:
      environment.dashboardUrl === '' ? null : environment.dashboardUrl,
    createdAt: null,
    readyAt: null,
    // Never framed: there is nothing to frame, and probing an address with no
    // deployment behind it would spend a request to learn that.
    embeddable: false,
    embedBlockedReason: null,
  };
}

function comparePreviews(
  a: ProjectBranchPreview,
  b: ProjectBranchPreview,
): number {
  if (a.isProduction !== b.isProduction) {
    return a.isProduction ? -1 : 1;
  }
  // An environment with no deployment has no date to rank by, so it sorts
  // after the ones that do rather than to an arbitrary place among them.
  if ((a.createdAt === null) !== (b.createdAt === null)) {
    return a.createdAt === null ? 1 : -1;
  }
  if (a.createdAt === null || b.createdAt === null) {
    return 0;
  }
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}
