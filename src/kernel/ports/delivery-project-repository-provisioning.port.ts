import type {
  DeploymentProvisioningRequest,
  DeploymentProvisioningResult,
} from './deployment-runtime.port';

/**
 * What identity-access/hierarchy hands to Projects to create ONE repository
 * inside an existing Project (delivery project) with the same full setup the
 * "Create project" wizard runs: GitHub repository, starter files, branches and
 * protection, the pipeline workflows, Actions secrets, and managed hosting.
 *
 * Projects owns every one of those steps; hierarchy only supplies the intent.
 */
export interface ProvisionDeliveryProjectRepositoryInput {
  userId: string;
  userLogin: string;
  githubAccessToken: string | null;
  /** The Project's team (hierarchy group / workspace). */
  workspaceId: string;
  deliveryProjectId: string;
  repoName: string;
  visibility: 'private' | 'public';
  /** Stack from the catalog, e.g. a frontend or backend project type. */
  projectTypeId: string;
  workflowRecipeId?: string;
  serviceName: string;
  /** A single repository: standalone (default) or a monorepo. */
  repoShape?: 'standalone' | 'monorepo';
  servicePath?: string;
  nodeVersion?: string;
  coverageThreshold?: number;
  tests?: Partial<Record<string, boolean>>;
  outputFileName?: string;
  /**
   * Hosting. Omitted -> the managed defaults the wizard applies (frontend to
   * Vercel, backend to Render).
   */
  deploymentProvisioning?: DeploymentProvisioningRequest;
}

export interface ProvisionedDeliveryProjectRepository {
  /** projects.provisioned_projects id. */
  provisionedProjectId: string;
  repoFullName: string;
  repoUrl: string;
  workflowPath: string;
  branchesCreated: string[];
  /** Hosting outcome; per-target failures carry their reason in errorSummary. */
  deploymentProvisioning: DeploymentProvisioningResult;
}

export interface DeliveryProjectRepositoryProvisioningPort {
  provisionRepository(
    input: ProvisionDeliveryProjectRepositoryInput,
  ): Promise<ProvisionedDeliveryProjectRepository>;
}

export const DELIVERY_PROJECT_REPOSITORY_PROVISIONING = Symbol(
  'DELIVERY_PROJECT_REPOSITORY_PROVISIONING',
);
