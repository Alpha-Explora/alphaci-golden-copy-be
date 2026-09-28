import type {
  EnvOwnershipMode,
  EnvProvider,
  EnvTargetSlot,
  RenderDeployMethod,
  RenderEnvironmentName,
  RenderRuntime,
  RenderServiceType,
} from '../../core/deployments.types';

export interface CreateDeploymentTargetDto {
  action: 'create' | 'register_existing';
  /**
   * Project environment this target deploys. When set, the target branch is
   * the environment's source branch and the environment may hold at most one
   * target per slot. Omit it for the legacy branch-based path.
   */
  environmentId?: string;
  slot: EnvTargetSlot;
  ownershipMode: EnvOwnershipMode;
  provider: EnvProvider;
  providerConnectionId?: string;
  providerProjectId?: string;
  providerProjectName?: string;
  projectName?: string;
  branchName?: string;
  rootDirectory?: string;
  buildCommand?: string;
  startCommand?: string;
  renderDeployMethod?: RenderDeployMethod;
  renderServiceType?: RenderServiceType;
  renderRuntime?: RenderRuntime;
  renderInstanceType?: string;
  renderRegion?: string;
  renderEnvironmentName?: RenderEnvironmentName;
  dockerContext?: string;
  dockerfilePath?: string;
  imageUrl?: string;
  environmentMap?: Record<string, unknown>;
}
