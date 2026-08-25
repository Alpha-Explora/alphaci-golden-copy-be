import { GoogleAuth, type AuthClient } from 'google-auth-library';

import {
  GcpRuntimeAdapterError,
  type EnsureArtifactRegistryInput,
  type EnsureArtifactRegistryResult,
  type EnsureCloudRunServiceInput,
  type EnsureCloudRunServiceResult,
  type GcpRuntimeAdapter,
  type GcpRuntimeLabels,
} from '../gcp-runtime.port';

interface GoogleAuthProvider {
  getClient(): Promise<AuthClient>;
}

interface OperationResponse {
  name?: string;
  done?: boolean;
  error?: unknown;
}

interface ArtifactRegistryRepositoryResponse {
  name?: string;
}

interface CloudRunServiceResponse {
  name?: string;
  uri?: string;
  latestReadyRevision?: string;
}

export class GoogleCloudRuntimeAdapter implements GcpRuntimeAdapter {
  constructor(
    private readonly auth: GoogleAuthProvider = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }),
    private readonly fetchFn: typeof fetch = fetch,
    private readonly delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async ensureArtifactRegistry(
    input: EnsureArtifactRegistryInput,
  ): Promise<EnsureArtifactRegistryResult> {
    const baseUrl = `https://artifactregistry.googleapis.com/v1/projects/${encodeURIComponent(input.gcpProjectId)}/locations/${encodeURIComponent(input.region)}`;
    let repository: ArtifactRegistryRepositoryResponse;

    try {
      repository = await this.request<ArtifactRegistryRepositoryResponse>(
        'GET',
        `${baseUrl}/repositories/${encodeURIComponent(input.repository)}`,
      );
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }

      const operation = await this.request<OperationResponse>(
        'POST',
        `${baseUrl}/repositories?repositoryId=${encodeURIComponent(input.repository)}`,
        {
          format: 'DOCKER',
          description: 'AlphaCI managed Cloud Run images',
          ...(input.labels ? { labels: this.toGcpLabels(input.labels) } : {}),
        },
      );
      await this.waitForOperation(
        'https://artifactregistry.googleapis.com/v1',
        operation,
      );
      repository = await this.request<ArtifactRegistryRepositoryResponse>(
        'GET',
        `${baseUrl}/repositories/${encodeURIComponent(input.repository)}`,
      );
    }

    return {
      resourceName:
        repository.name ?? `${baseUrl}/repositories/${input.repository}`,
      repositoryUri: `${input.region}-docker.pkg.dev/${input.gcpProjectId}/${input.repository}`,
    };
  }

  async ensureCloudRunService(
    input: EnsureCloudRunServiceInput,
  ): Promise<EnsureCloudRunServiceResult> {
    const baseUrl = `https://run.googleapis.com/v2/projects/${encodeURIComponent(input.gcpProjectId)}/locations/${encodeURIComponent(input.region)}`;
    let service: CloudRunServiceResponse;

    try {
      service = await this.request<CloudRunServiceResponse>(
        'GET',
        `${baseUrl}/services/${encodeURIComponent(input.serviceName)}`,
      );
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
      if (!this.isContainerImage(input.imageName)) {
        throw new GcpRuntimeAdapterError(
          'GCP_CLOUD_RUN_IMAGE_REQUIRED',
          'A fully qualified container image is required to create a Cloud Run service',
        );
      }

      const operation = await this.request<OperationResponse>(
        'POST',
        `${baseUrl}/services?serviceId=${encodeURIComponent(input.serviceName)}`,
        {
          ingress: 'INGRESS_TRAFFIC_ALL',
          labels: this.toGcpLabels(input.labels),
          template: {
            serviceAccount: input.runtimeServiceAccountEmail,
            containers: [{ image: input.imageName }],
            scaling: { maxInstanceCount: 2 },
          },
        },
      );
      await this.waitForOperation('https://run.googleapis.com/v2', operation);
      service = await this.request<CloudRunServiceResponse>(
        'GET',
        `${baseUrl}/services/${encodeURIComponent(input.serviceName)}`,
      );
    }

    return {
      resourceName: service.name ?? `${baseUrl}/services/${input.serviceName}`,
      serviceUrl:
        service.uri ??
        `https://${input.serviceName}-${input.gcpProjectId}.a.run.app`,
      revision: service.latestReadyRevision ?? 'pending',
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const client = await this.auth.getClient();
    const authHeaders = await client.getRequestHeaders(url);
    const response = await this.fetchFn(url, {
      method,
      headers: {
        ...authHeaders,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new GcpRuntimeAdapterError(
        response.status === 404 ? 'GCP_RESOURCE_NOT_FOUND' : 'GCP_REQUEST_FAILED',
        response.status === 404
          ? 'The requested GCP resource was not found'
          : 'The GCP request failed',
      );
    }

    return (await response.json()) as T;
  }

  private async waitForOperation(
    baseUrl: string,
    operation: OperationResponse,
  ): Promise<void> {
    if (operation.error) {
      throw new GcpRuntimeAdapterError(
        'GCP_OPERATION_FAILED',
        'The GCP operation failed',
      );
    }
    if (operation.done) {
      return;
    }
    if (!operation.name) {
      throw new GcpRuntimeAdapterError(
        'GCP_OPERATION_INVALID',
        'The GCP operation did not return a name',
      );
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.request<OperationResponse>(
        'GET',
        `${baseUrl}/${operation.name}`,
      );
      if (current.error) {
        throw new GcpRuntimeAdapterError(
          'GCP_OPERATION_FAILED',
          'The GCP operation failed',
        );
      }
      if (current.done) {
        return;
      }
      await this.delay(Math.min(1_000 * 2 ** attempt, 15_000));
    }

    throw new GcpRuntimeAdapterError(
      'GCP_OPERATION_TIMEOUT',
      'The GCP operation did not finish in time',
    );
  }

  private isNotFound(error: unknown): boolean {
    return (
      error instanceof GcpRuntimeAdapterError &&
      error.code === 'GCP_RESOURCE_NOT_FOUND'
    );
  }

  private isContainerImage(imageName: string): boolean {
    return /[a-z0-9-]+-docker\.pkg\.dev\/.+/.test(imageName);
  }

  private toGcpLabels(labels: GcpRuntimeLabels): Record<string, string> {
    return {
      'alphaci-workspace': labels.workspaceId.toLowerCase(),
      'alphaci-project': labels.projectId.toLowerCase(),
      environment: labels.environment,
      ...(labels.deploymentTargetId
        ? { 'deployment-target': labels.deploymentTargetId.toLowerCase() }
        : {}),
      ...(labels.correlationId
        ? { correlation: labels.correlationId.toLowerCase() }
        : {}),
    };
  }
}
