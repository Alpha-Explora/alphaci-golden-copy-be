import type {
  DeploymentHistoryStatus,
  DeploymentSlot,
  EnvProvider,
} from '#kernel/ports/deployment-runtime.port';
import type { PreviewSurface } from '../../domain/preview-surface.rule';

/**
 * One branch's current deployment.
 *
 * The unit here is the branch, not the deployment: a branch's preview is
 * whatever its newest deployment is, which is also what Vercel's own branch
 * alias resolves to. Grouping this way means a push to a branch updates that
 * branch's card in place instead of appending another row nobody reads.
 */
/**
 * `not_deployed` is an environment that exists and has never been released to.
 *
 * Not a deployment status, which is why it is not in DeploymentHistoryStatus:
 * nothing ran, so there is nothing for a provider to report. It is here
 * because the branch is still a real environment with a real address, and a
 * project provisioned an hour ago is made entirely of them.
 */
export type ProjectBranchPreviewStatus =
  | DeploymentHistoryStatus
  | 'not_deployed';

export interface ProjectBranchPreview {
  branch: string;
  /** True for the branch the provider deploys to production. */
  isProduction: boolean;
  /** Null when nothing has been deployed to this environment yet. */
  deploymentId: string | null;
  targetId: string;
  targetName: string;
  provider: EnvProvider;
  /** The target's role. Null only for an older/degraded source that cannot report it. */
  slot: DeploymentSlot | null;
  /** What the card renders: a live log tail for a backend target, the page thumbnail otherwise. */
  surface: PreviewSurface;
  /** Host-neutral display name for `provider`, falling back to the id when the provider is not in the catalog. */
  providerLabel: string;
  /** Whether this provider both declares and implements log retrieval. */
  logsAvailable: boolean;
  /**
   * The window a 'logs' surface should tail: from the current deployment's
   * start to now (`endTime: null` means live). Null when nothing is deployed
   * yet, so there is no window to tail.
   */
  logWindow: { startTime: string; endTime: string | null } | null;
  status: ProjectBranchPreviewStatus;
  commitSha: string | null;
  commitMessage: string | null;
  /** Set when the branch's newest deployment was built for a pull request. */
  pullRequestNumber: number | null;
  /** Who started the newest deployment, when the provider says. */
  createdBy: string | null;
  /**
   * The URL to open, and to frame when `embeddable` is true: the
   * environment's stable address where it has one, which is what the provider
   * lists as the branch's domain and keeps pointing at its newest release.
   * Falls back to the deployment's own address.
   */
  previewUrl: string | null;
  /**
   * This one deployment's own address. On Vercel it is unique per deployment
   * and sits behind deployment protection, so it is linked, never framed.
   */
  deploymentUrl: string | null;
  inspectorUrl: string | null;
  /** Null for an environment with no deployment to date. */
  createdAt: string | null;
  readyAt: string | null;
  /** null means undetermined — the UI must not frame it, but should still link it. */
  embeddable: boolean | null;
  embedBlockedReason: string | null;
}

export interface ProjectPreviewsResponse {
  enabled: boolean;
  /** False when no provider integration is connected, so the list is empty rather than live. */
  liveProvidersEnabled: boolean;
  branches: ProjectBranchPreview[];
  /**
   * Safe message when a provider could not be reached.
   *
   * Carried so an empty list is not read as "no branch has been deployed" when
   * the real reason is that the provider did not answer.
   */
  providerError: string | null;
}
