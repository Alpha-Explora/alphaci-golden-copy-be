export const GCP_RUNTIME_ADAPTER = Symbol('GCP_RUNTIME_ADAPTER');

export type GcpRuntimeEnvironment = 'dev' | 'stg' | 'uat' | 'prod' | 'preview';

export interface GcpRuntimeLabels {
  workspaceId: string;
  projectId: string;
  environment: GcpRuntimeEnvironment;
  deploymentTargetId?: string;
  correlationId?: string;
}

export interface EnsureArtifactRegistryInput {
  gcpProjectId: string;
  region: string;
  repository: string;
  labels?: GcpRuntimeLabels;
}

export interface EnsureArtifactRegistryResult {
  repositoryUri: string;
  resourceName?: string;
}

export interface EnsureCloudRunServiceInput {
  gcpProjectId: string;
  region: string;
  serviceName: string;
  imageName: string;
  runtimeServiceAccountEmail: string;
  labels: GcpRuntimeLabels;
}

export interface EnsureCloudRunServiceResult {
  resourceName: string;
  serviceUrl: string;
  revision: string;
}

export interface GcpRuntimeAdapter {
  ensureArtifactRegistry(
    input: EnsureArtifactRegistryInput,
  ): Promise<EnsureArtifactRegistryResult>;
  ensureCloudRunService(
    input: EnsureCloudRunServiceInput,
  ): Promise<EnsureCloudRunServiceResult>;
}

export class GcpRuntimeAdapterError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'GcpRuntimeAdapterError';
  }
}
