/**
 * Public deployment-provisioning contract.
 *
 * This file deliberately contains plain TypeScript shapes only.  The
 * projects context owns the HTTP DTOs and their validation decorators; the
 * deployments context owns the application contract used after validation.
 * Keeping the two separate prevents the deployment implementation from
 * importing presentation types from Projects.
 */

export type DeploymentProvider = 'render' | 'vercel';
export type DeploymentSlot = 'backend' | 'frontend' | 'standalone';
export type DeploymentOwnershipMode = 'byo' | 'flowci_managed';
export type DeploymentProvisioningAction = 'create' | 'register_existing';
export type DeploymentEnvironmentLane = 'production' | 'preview';

export interface DeploymentProvisioningEnvVar {
  key: string;
  value: string;
}

export interface DeploymentProvisioningEnvSet {
  lane: DeploymentEnvironmentLane;
  gitBranch?: string;
  vars: DeploymentProvisioningEnvVar[];
}

export interface DeploymentProvisioningTarget {
  action?: DeploymentProvisioningAction;
  slot: DeploymentSlot;
  provider: DeploymentProvider;
  ownershipMode: DeploymentOwnershipMode;
  providerConnectionId?: string;
  projectName?: string;
  providerProjectId?: string;
  providerProjectName?: string;
  branchName?: string;
  rootDirectory?: string;
  buildCommand?: string;
  startCommand?: string;
  renderDeployMethod?:
    | 'managed_image'
    | 'byo_image'
    | 'native_git'
    | 'existing_service';
  renderServiceType?:
    | 'web_service'
    | 'private_service'
    | 'background_worker'
    | 'cron_job';
  renderRuntime?:
    | 'node'
    | 'python'
    | 'ruby'
    | 'go'
    | 'rust'
    | 'elixir'
    | 'docker';
  renderInstanceType?: string;
  renderRegion?: string;
  renderEnvironmentName?: 'test' | 'uat' | 'production';
  dockerContext?: string;
  dockerfilePath?: string;
  imageUrl?: string;
  env?: DeploymentProvisioningEnvSet[];
}

export interface DeploymentProvisioningVariableGroup {
  name?: string;
  provider: DeploymentProvider;
  appliesTo?: 'all' | 'selected';
  targetBranches?: string[];
  env: DeploymentProvisioningEnvSet[];
}

export interface DeploymentProvisioningRequest {
  enabled: boolean;
  variableGroups?: DeploymentProvisioningVariableGroup[];
  sharedEnv?: DeploymentProvisioningEnvSet[];
  targets: DeploymentProvisioningTarget[];
}

export interface DeploymentProvisioningInput {
  projectId: string;
  userId: string;
  repoFullName: string;
  githubAccessToken?: string;
  request: DeploymentProvisioningRequest | undefined;
}

export type DeploymentProvisioningResult = {
  status: 'skipped' | 'completed' | 'partial' | 'failed';
  targets: Array<{
    slot: DeploymentSlot;
    provider: DeploymentProvider;
    ownershipMode: DeploymentOwnershipMode;
    deploymentStrategy:
      | 'provider_native'
      | 'vercel_git_connected'
      | 'vercel_ci_pushed'
      | 'render_git_connected'
      | 'render_image_pushed'
      | 'render_existing_service'
      | null;
    status: 'created' | 'registered' | 'failed';
    deploymentTargetId: string | null;
    providerProjectId: string | null;
    providerProjectName: string | null;
    providerMetadata: Record<string, unknown>;
    renderServiceType?: string | null;
    renderRuntime?: string | null;
    renderInstanceType?: string | null;
    renderRegion?: string | null;
    renderEnvironmentName?: 'test' | 'uat' | 'production' | null;
    dockerContext?: string | null;
    dockerfilePath?: string | null;
    imageUrl?: string | null;
    branchName?: string | null;
    errorSummary: string | null;
    env: Array<{
      lane: DeploymentEnvironmentLane;
      gitBranch: string | null;
      provisioned: Array<{ key: string; status: 'provisioned' }>;
      failed: Array<{
        key: string;
        status: 'failed';
        errorSummary: string;
      }>;
    }>;
  }>;
};

export interface DeploymentProvisioningFacade {
  provisionForProject(
    input: DeploymentProvisioningInput,
  ): Promise<DeploymentProvisioningResult>;
  crossLinkServiceUrls(input: {
    userId: string;
    request: DeploymentProvisioningRequest | undefined;
    groups: Array<{
      projectId: string;
      result: DeploymentProvisioningResult;
    }>;
  }): Promise<void>;
}

export const DEPLOYMENT_PROVISIONING_FACADE = Symbol(
  'DEPLOYMENT_PROVISIONING_FACADE',
);
