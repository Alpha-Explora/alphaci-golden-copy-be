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
    let providerMetadataUpdates: Record<string, unknown> | undefined;
    if (artifact && this.requiresImagePatch(artifact, configured, bootstrap)) {
      await this.patchServiceImage(request.target, serviceId, artifact, token);
      // Handed back rather than written into request.target: the caller owns
      // persistence, and an in-memory edit of a row it read is lost with the
      // request, which is how every release used to re-patch.
      providerMetadataUpdates = { imageUrl: artifact };
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

    return {
      ...this.toHandle(deployId, payload.status, request.target),
      ...(providerMetadataUpdates ? { providerMetadataUpdates } : {}),
    };
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

  /**
   * Points the service at the image the pipeline built.
   *
   * The body mirrors the one the service was created with (render-env.client
   * `buildCreateServiceBody`): Render treats `image` as a replacement, so a
   * PATCH that leaves out the registry credential drops it, and Render then
   * tries to pull a private GHCR image anonymously and answers
   * "unable to fetch image with provided input".
   */
  private async patchServiceImage(
    target: DeploymentTargetSummary,
    serviceId: string,
    imagePath: string,
    token: string,
  ): Promise<void> {
    const ownerId = this.stringMetadata(target, 'renderOwnerId');
    const registryCredentialId = this.registryCredentialId(target);

    const response = await fetch(`${RENDER_API_URL}/services/${serviceId}`, {
      method: 'PATCH',
      headers: this.headers(token),
      body: JSON.stringify({
        image: {
          ...(ownerId ? { ownerId } : {}),
          imagePath,
          ...(registryCredentialId ? { registryCredentialId } : {}),
        },
      }),
    });

    await this.readPayload(
      response,
      'Render refused to update the service image',
    );
  }

  /** The credential recorded on the target at creation, else the configured shared one. */
  private registryCredentialId(target: DeploymentTargetSummary): string | null {
    const recorded = this.stringMetadata(target, 'renderRegistryCredentialId');
    if (recorded) {
      return recorded;
    }
    const config = this.configService.getOrThrow<AppConfig>('app');
    return (
      config.envProvisioning.flowciManaged.renderRegistryCredentialId?.trim() ||
      null
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
      const detail = this.providerDetail(body);
      const status = `HTTP ${String(response.status)}`;
      const hint = /unable to fetch image/i.test(detail)
        ? " Check that the registry credential Render holds can read this image (a GitHub token needs read:packages for the package's organisation)."
        : '';
      throw new BadGatewayException(
        detail
          ? `${message} (${status}): ${detail}.${hint}`
          : `${message} (${status}).`,
      );
    }

    return (await response.json()) as RenderDeployPayload;
  }

  /**
   * Render's own explanation of a refusal, safe to hand to the pipeline.
   *
   * Render answers `{"message":"..."}`; the sentence is what an operator needs,
   * the envelope is noise. Anything credential-shaped is masked because this
   * text travels to a customer repository's logs.
   */
  private providerDetail(body: string): string {
    let text = body.trim();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const candidate = record['message'] ?? record['error'];
        if (typeof candidate === 'string') {
          text = candidate;
        } else if (Array.isArray(candidate)) {
          text = candidate.map(String).join('; ');
        }
      }
    } catch {
      // Not JSON: keep the raw text.
    }

    return text
      .replace(/\b(rnd_|gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.$/, '')
      .slice(0, 300);
  }
}
