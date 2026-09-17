import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import type { DeploymentTargetSummary } from '../../../core/deployments.types';
import type {
  ProviderReleaseHandle,
  ProviderReleaseRequest,
  ProviderReleaseStatus,
  ProviderReleaser,
} from '../../../application/ports/provider-releaser.port';

const RENDER_API_URL = 'https://api.render.com/v1';

/**
 * Render's own vocabulary for how a deploy is going.
 *
 * Mapped rather than passed through: the pipeline waits on four outcomes, and
 * an unknown Render status must not read as success. Anything unrecognised
 * counts as still running, so the wait ends at the caller's timeout with the
 * status named, instead of a release being called live because nobody had
 * taught this map a new word.
 */
const RENDER_STATUS: Record<string, ProviderReleaseStatus> = {
  created: 'pending',
  queued: 'pending',
  build_in_progress: 'in_progress',
  pre_deploy_in_progress: 'in_progress',
  update_in_progress: 'in_progress',
  live: 'live',
  build_failed: 'failed',
  pre_deploy_failed: 'failed',
  update_failed: 'failed',
  canceled: 'failed',
  deactivated: 'failed',
};

interface RenderDeployPayload {
  id?: string;
  status?: string;
  commit?: { id?: string } | null;
}

/**
 * Releases an image-backed Render service.
 *
 * Render only offers a deploy hook from its dashboard, so there is no way to
 * create one for a service the platform provisions - which is why
 * `render-deploy.yml` in auto mode silently became verify-only and the images
 * CI pushed were never deployed. The trigger-deploy API needs no hook, only the
 * API key this deployment already holds.
 */
@Injectable()
export class RenderReleaseService implements ProviderReleaser {
  readonly provider = 'render';

  constructor(private readonly configService: ConfigService) {}

  supports(target: DeploymentTargetSummary): boolean {
    return (
      target.provider === this.provider &&
      target.deploymentStrategy === 'render_image_pushed' &&
      target.ownershipMode === 'flowci_managed'
    );
  }

  async start(request: ProviderReleaseRequest): Promise<ProviderReleaseHandle> {
    const token = this.managedToken();
    const serviceId = request.target.providerProjectId;

    /*
     * Render accepts a different tag, but the host, repository and image name
     * must match what the service was configured with. Sending an artifact
     * from elsewhere would be refused by Render with a message about the image
     * rather than about the mismatch, so it is refused here where the reason
     * can be stated.
     */
    const imageUrl = this.resolveImageUrl(request);
    const response = await fetch(
      `${RENDER_API_URL}/services/${serviceId}/deploys`,
      {
        method: 'POST',
        headers: this.headers(token),
        body: JSON.stringify(imageUrl ? { imageUrl } : {}),
      },
    );

    const payload = await this.readPayload(
      response,
      'Render refused the deploy',
    );
    const deployId = payload.id;
    if (!deployId) {
      throw new Error('Render accepted the deploy but returned no deploy id');
    }

    return this.toHandle(deployId, payload.status, request.target);
  }

  async check(input: {
    target: DeploymentTargetSummary;
    providerReleaseId: string;
  }): Promise<ProviderReleaseHandle> {
    const token = this.managedToken();
    const serviceId = input.target.providerProjectId;
    const response = await fetch(
      `${RENDER_API_URL}/services/${serviceId}/deploys/${input.providerReleaseId}`,
      { headers: this.headers(token) },
    );

    const payload = await this.readPayload(
      response,
      'Render deploy status could not be read',
    );
    return this.toHandle(input.providerReleaseId, payload.status, input.target);
  }

  private toHandle(
    deployId: string,
    renderStatus: string | undefined,
    target: DeploymentTargetSummary,
  ): ProviderReleaseHandle {
    const raw = (renderStatus ?? '').trim();
    const status = RENDER_STATUS[raw] ?? 'in_progress';
    return {
      providerReleaseId: deployId,
      status,
      serviceUrl: this.serviceUrl(target),
      message:
        status === 'failed'
          ? `Render reported '${raw || 'an unnamed failure'}'. Open the service's Events tab in Render for the build or start-up log.`
          : raw
            ? `Render status: ${raw}`
            : null,
    };
  }

  /**
   * The image to deploy: the commit-tagged artifact the pipeline just pushed,
   * falling back to the image the service was created with.
   */
  private resolveImageUrl(request: ProviderReleaseRequest): string | null {
    const artifact = request.artifact?.trim();
    const configured = this.stringMetadata(request.target, 'imageUrl');

    if (!artifact) {
      return configured;
    }
    if (!configured) {
      return artifact;
    }

    const repositoryOf = (reference: string) =>
      reference.split('@')[0]!.replace(/:[^:/]+$/, '');
    if (repositoryOf(artifact) !== repositoryOf(configured)) {
      throw new Error(
        `The pipeline built ${artifact}, but this service deploys ${configured}. ` +
          'Render only accepts a different tag of the same image, so the target ' +
          'and the pipeline disagree about what this service runs.',
      );
    }

    return artifact;
  }

  private serviceUrl(target: DeploymentTargetSummary): string | null {
    return (
      this.stringMetadata(target, 'renderServiceUrl') ??
      this.stringMetadata(target, 'serviceUrl') ??
      this.stringMetadata(target, 'url')
    );
  }

  private stringMetadata(
    target: DeploymentTargetSummary,
    key: string,
  ): string | null {
    const value = target.providerMetadata[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private managedToken(): string {
    const config = this.configService.getOrThrow<AppConfig>('app');
    const token = config.envProvisioning.flowciManaged.renderToken.trim();
    if (!token) {
      throw new Error(
        'ALPHACI_RENDER_API_KEY is required to release an ALPHACI-managed Render service',
      );
    }
    return token;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async readPayload(
    response: Response,
    message: string,
  ): Promise<RenderDeployPayload> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // The body is Render's, and it can carry the service id; the key never
      // appears in it. Truncated because a Render error page is not a log line.
      throw new Error(
        `${message} (HTTP ${String(response.status)}). ${body.slice(0, 300)}`.trim(),
      );
    }

    return (await response.json()) as RenderDeployPayload;
  }
}
