import type { EnvProvider } from '../env-provisioning/env-provisioning.types';

export type DeploymentHistoryStatus =
  | 'queued'
  | 'building'
  | 'ready'
  | 'failed'
  | 'canceled'
  | 'unknown';

export interface ProjectDeploymentHistoryItem {
  id: string;
  targetId: string;
  targetName: string;
  provider: EnvProvider;
  /**
   * Which environment this deployment went to. Taken from the provider's own
   * lane when it reports one ('production' / 'preview' on Vercel) and from
   * the target's configured Render environment name otherwise.
   */
  environment: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  status: DeploymentHistoryStatus;
  createdAt: string;
  readyAt: string | null;
  /**
   * The deployed site itself. Per-deployment where the provider gives each
   * deployment its own hostname (Vercel), otherwise the target's stable
   * public URL (Render). Null when neither is resolvable.
   */
  deploymentUrl: string | null;
  /** Set when the deployment was built for a pull request. */
  pullRequestNumber: number | null;
  /** Provider console for this single deployment, when the provider has one. */
  inspectorUrl: string | null;
  /** Provider console for the project as a whole. */
  dashboardUrl: string;
  /** Provider console's deployment list for the project. */
  consoleUrl: string;
}
