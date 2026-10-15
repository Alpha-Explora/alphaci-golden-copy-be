import type { DeploymentTargetSummary } from '../../core/deployments.types';
import type { DeploymentHistoryItem } from '../../core/deployment-provisioning.contract';

/** History that is owned by AlphaCI rather than a remote provider API. */
export interface DeploymentHistorySource {
  readonly provider: string;
  read(
    target: DeploymentTargetSummary,
    userId: string,
  ): Promise<DeploymentHistoryItem[]>;
}
