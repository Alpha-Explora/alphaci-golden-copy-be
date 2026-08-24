/**
 * Deployments — public API.
 *
 * This is the only cross-module surface for deployment behavior. Repositories,
 * provider clients, and HTTP DTOs remain private to the deployment module.
 *
 * Treat an entry below as a contract other modules depend on. Add to it only
 * when a second module genuinely needs the thing.
 */

// Provider URL conventions. Shared so that "where does this service answer?"
// has exactly one answer in the backend — the target listing and the
// deployment history both need it, and a provider changing its hostname
// format should be a one-line edit.
export { providerPublicUrl } from './provider-public-url';

// Contracts: the shapes crossing this boundary. Which provider hosts a thing
// is stamped on every deployment and preview payload the projects module
// returns, so it is part of this module's public vocabulary.
export type {
  DeploymentTargetSummary,
  EnvProvider,
  EnvVarMetadata,
} from './deployments.types';
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
} from './deployment-provisioning.contract';

export type {
  ProjectDriftFinding,
  ProjectDriftFindingInput,
  ProjectDriftRepairAction,
  ProjectDriftRepairResponse,
  ProjectDriftResponse,
} from './application/project-drift.types';
