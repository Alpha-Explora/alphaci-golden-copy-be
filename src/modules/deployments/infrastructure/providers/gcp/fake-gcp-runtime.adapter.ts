import type {
  EnsureArtifactRegistryInput,
  EnsureArtifactRegistryResult,
  EnsureCloudRunServiceInput,
  EnsureCloudRunServiceResult,
  GcpRuntimeAdapter,
} from './gcp-runtime.port';

export class FakeGcpRuntimeAdapter implements GcpRuntimeAdapter {
  readonly calls: Array<{
    operation: 'ensureArtifactRegistry' | 'ensureCloudRunService';
    input: EnsureArtifactRegistryInput | EnsureCloudRunServiceInput;
  }> = [];

  async ensureArtifactRegistry(
    input: EnsureArtifactRegistryInput,
  ): Promise<EnsureArtifactRegistryResult> {
    this.calls.push({ operation: 'ensureArtifactRegistry', input });

    return {
      repositoryUri: `${input.region}-docker.pkg.dev/${input.gcpProjectId}/${input.repository}`,
    };
  }

  async ensureCloudRunService(
    input: EnsureCloudRunServiceInput,
  ): Promise<EnsureCloudRunServiceResult> {
    this.calls.push({ operation: 'ensureCloudRunService', input });

    return {
      resourceName: `projects/${input.gcpProjectId}/locations/${input.region}/services/${input.serviceName}`,
      serviceUrl: `https://${input.serviceName}-${input.gcpProjectId}.a.run.app`,
      revision: 'mock-revision',
    };
  }
}
