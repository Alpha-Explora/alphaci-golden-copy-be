import type {
  DeploymentHistoryStatus,
  EnvProvider,
} from '#modules/runtime/index.js';

/**
 * One branch's current deployment.
 *
 * The unit here is the branch, not the deployment: a branch's preview is
 * whatever its newest deployment is, which is also what Vercel's own branch
 * alias resolves to. Grouping this way means a push to a branch updates that
 * branch's card in place instead of appending another row nobody reads.
 */
export interface ProjectBranchPreview {
  branch: string;
  /** True for the branch the provider deploys to production. */
  isProduction: boolean;
  deploymentId: string;
  targetId: string;
  targetName: string;
  provider: EnvProvider;
  status: DeploymentHistoryStatus;
  commitSha: string | null;
  commitMessage: string | null;
  /** Set when the branch's newest deployment was built for a pull request. */
  pullRequestNumber: number | null;
  /** The URL to open, and to frame when `embeddable` is true. */
  previewUrl: string | null;
  inspectorUrl: string | null;
  createdAt: string;
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
