import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
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
    if (!serviceId) {
      throw new BadRequestException(
        'Deployment target has no Render service ID',
      );
    }

    const artifact = request.artifact?.trim();
    const configured = this.stringMetadata(request.target, 'imageUrl');
    const bootstrap = this.stringMetadata(request.target, 'bootstrapImage');

    /*
     * Render's deploy endpoint accepts a different tag of the SAME image repository.
     * When transitioning from the initial bootstrap image (e.g. nginx:alpine) to the
     * pipeline's built container image (e.g. ghcr.io/org/repo:sha-xyz), or switching
     * image repositories, the backing image must first be updated via PATCH /services.
     */
    if (artifact && this.requiresImagePatch(artifact, configured, bootstrap)) {
      await this.patchServiceImage(serviceId, artifact, token);
      request.target.providerMetadata['imageUrl'] = artifact;
    }

    const imageUrl = artifact || configured;
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
      throw new BadGatewayException(
        'Render accepted the deploy but returned no deploy id',
      );
    }

    return this.toHandle(deployId, payload.status, request.target);
  }

  async check(input: {
    target: DeploymentTargetSummary;
    providerReleaseId: string;
  }): Promise<ProviderReleaseHandle> {
    const token = this.managedToken();
    const serviceId = input.target.providerProjectId;
    if (!serviceId) {
      throw new BadRequestException(
        'Deployment target has no Render service ID',
      );
    }
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

  private requiresImagePatch(
    artifact: string,
    configured: string | null,
    bootstrap: string | null,
  ): boolean {
    if (!configured) {
      return true;
    }

    const repositoryOf = (reference: string) =>
      reference.split('@')[0]!.replace(/:[^:/]+$/, '');

    if (bootstrap && repositoryOf(configured) === repositoryOf(bootstrap)) {
      return true;
    }

    return repositoryOf(artifact) !== repositoryOf(configured);
  }

  private async patchServiceImage(
    serviceId: string,
    imagePath: string,
    token: string,
  ): Promise<void> {
    const response = await fetch(`${RENDER_API_URL}/services/${serviceId}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({
        image: {
          imagePath,
        },
      }),
    });

    await this.readPayload(
      response,
      'Render refused to update the service image',
    );
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
      throw new BadRequestException(
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
      const detail = body ? body.slice(0, 300) : '';
      throw new BadGatewayException(
        `${message} (HTTP ${String(response.status)}). ${detail}`.trim(),
      );
    }

    return (await response.json()) as RenderDeployPayload;
  }
}
