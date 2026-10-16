/**
 * Runtime — public API.
 *
 * This is the only cross-module surface for deployment behavior. Repositories,
 * provider clients, and HTTP DTOs remain private to the runtime module.
 *
 * Treat an entry below as a contract other modules depend on. Add to it only
 * when a second module genuinely needs the thing.
 */

// Contracts: the shapes crossing this boundary. Which provider hosts a thing
// is stamped on every deployment and preview payload the projects module
// returns, so it is part of this module's public vocabulary.
export type {
  DeploymentTargetSummary,
  EnvProvider,
  EnvVarMetadata,
} from './core/deployments.types';
export {
  type DeploymentProvider,
  type DeploymentProviderId,
} from './core/deployment-provider.contract';
export {
  DEFAULT_BACKEND_PROVIDER_ID,
  DEFAULT_FRONTEND_PROVIDER_ID,
} from './core/deployment-provider.defaults';
export { DeploymentProviderRegistry } from './core/deployment-provider.registry';
export {
  DeploymentProviderPolicyRegistry,
  type DeploymentProviderPolicy,
  type DeploymentProviderManagedQuota,
  type DeploymentProviderTargetPolicyInput,
  type DeploymentProviderTargetPolicyResult,
} from './domain/deployment-provider.policy';
export {
  buildDeploymentWorkflowFragment,
  WORKFLOW_FRAGMENTS,
  WorkflowFragmentRegistry,
  type WorkflowFragment,
  type WorkflowFragmentContext,
  type WorkflowFragmentResult,
  type WorkflowFragmentTarget,
  type WorkflowTargetExpansionContext,
  type WorkflowTargetExpansionInput,
} from './infrastructure/providers/core/workflow-fragment.registry';
export { createDefaultWorkflowFragmentRegistry } from './infrastructure/providers/core/default-workflow-fragment-registry';
export type { DeploymentProviderContract } from './contracts/deployment-provider.contract';
export type { DeploymentProvisioningContract } from './contracts/deployment-provisioning.contract';
export {
  DEPLOYMENT_USAGE_FACTS,
  type DeploymentUsageFact,
  type DeploymentUsageProviderId,
} from './core/deployment-usage.contract';
// Deployment provisioning is consumed by Projects through this facade.  The
// implementation remains private to this module so Projects cannot couple to
// provider orchestration details.
export {
  DEPLOYMENT_PROVISIONING_FACADE,
  DEPLOYMENT_HISTORY_QUERY,
  DEPLOYMENT_DRIFT_QUERY,
  DEPLOYMENT_DRIFT_FINDINGS_STORE,
  DEPLOYMENT_TARGETS_QUERY,
  DEPLOYMENT_ENV_METADATA_QUERY,
  DEPLOYMENT_TARGET_DELETION,
  DEPLOYMENT_PROVIDER_RESOURCES_TEARDOWN,
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  type DeploymentProvisioningFacade,
  type DeploymentProvisioningInput,
  type DeploymentProjectReference,
  type DeploymentProjectReferenceLookup,
  type DeploymentProvisioningRequest,
  type DeploymentProvisioningResult,
  type DeploymentHistoryQuery,
  type DeploymentHistoryResponse,
  type DeploymentHistoryItem,
  type DeploymentHistoryMode,
  type DeploymentHistoryStatus,
  type DeploymentDriftQuery,
  type DeploymentDriftResponse,
  type DeploymentDriftFinding,
  type DeploymentDriftFindingInput,
  type DeploymentDriftFindingsStore,
  type DeploymentTargetsQuery,
  type DeploymentEnvMetadataQuery,
  type DeploymentTargetDeletion,
} from './core/deployment-provisioning.contract';
export {
  DEPLOYMENT_PROVISIONING_DEFAULTS,
  type DeploymentProvisioningDefaultsPort,
} from './core/deployment-provisioning.defaults';

// The composition root registers the app-wide throttler with these named
// throttlers, which key agent routes per machine rather than per client IP.
export {
  isOnpremMachineRoute,
  ONPREM_AGENT_THROTTLERS,
  OnpremMachineThrottlerGuard,
} from './api/onprem-machine-throttler.guard';

export type {
  ProjectDriftFinding,
  ProjectDriftFindingInput,
  ProjectDriftRepairAction,
  ProjectDriftRepairResponse,
  ProjectDriftResponse,
} from './application/project-drift.types';
