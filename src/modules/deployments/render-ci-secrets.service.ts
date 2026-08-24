import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { GithubService } from '../github/index.js';
import { EnvTokenEncryptionService } from './encryption.service';
import type {
  DeploymentTargetSummary,
  EnvTargetSlot,
} from './deployments.types';
import { ProviderConnectionsRepository } from './provider-connections.repository';

export interface RenderCiSecretNames {
  apiKey: string;
  serviceId: string;
  ownerId: string;
  registryCredentialId: string;
  deployHookUrl: string;
  healthcheckUrl: string;
}

@Injectable()
export class RenderCiSecretsService {
  constructor(
    private readonly githubService: GithubService,
    private readonly providerConnectionsRepository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    private readonly configService: ConfigService,
  ) {}

  async installForTarget(input: {
    githubAccessToken: string;
    repoFullName: string;
    userId: string;
    providerConnectionId: string | null;
    target: DeploymentTargetSummary;
  }): Promise<{ githubSecrets: RenderCiSecretNames }> {
    if (
      input.target.provider !== 'render' ||
      !['render_image_pushed', 'render_existing_service'].includes(
        input.target.deploymentStrategy,
      )
    ) {
      return {
        githubSecrets: this.renderSecretNames(
          input.target.slot,
          input.target.branchName,
        ),
      };
    }

    const [owner, repo] = this.parseRepoFullName(input.repoFullName);
    const secretNames = this.renderSecretNames(
      input.target.slot,
      input.target.branchName,
    );
    const renderApiKey = await this.resolveRenderToken(input);

    await this.githubService.setActionsSecretStrict(
      input.githubAccessToken,
      owner,
      repo,
      secretNames.apiKey,
      renderApiKey,
    );
    await this.githubService.setActionsSecretStrict(
      input.githubAccessToken,
      owner,
      repo,
      secretNames.serviceId,
      input.target.providerProjectId,
    );
    await this.githubService.setActionsSecretStrict(
      input.githubAccessToken,
      owner,
      repo,
      secretNames.ownerId,
      await this.resolveRenderOwnerId(input),
    );
    const registryCredentialId = this.providerMetadataString(
      input.target.providerMetadata,
      'renderRegistryCredentialId',
    );
    if (registryCredentialId) {
      await this.githubService.setActionsSecretStrict(
        input.githubAccessToken,
        owner,
        repo,
        secretNames.registryCredentialId,
        registryCredentialId,
      );
    }
    const deployHookUrl = this.providerMetadataString(
      input.target.providerMetadata,
      'renderDeployHookUrl',
    );
    if (deployHookUrl) {
      await this.githubService.setActionsSecretStrict(
        input.githubAccessToken,
        owner,
        repo,
        secretNames.deployHookUrl,
        deployHookUrl,
      );
    }
    const healthcheckUrl = this.resolveRenderHealthcheckUrl(input.target);
    if (healthcheckUrl) {
      await this.githubService.setActionsSecretStrict(
        input.githubAccessToken,
        owner,
        repo,
        secretNames.healthcheckUrl,
        healthcheckUrl,
      );
    }

    return { githubSecrets: secretNames };
  }

  renderSecretNames(
    slot: EnvTargetSlot,
    branchName: string | null | undefined = 'uat',
  ): RenderCiSecretNames {
    const branch = branchName === 'main' ? branchName : 'uat';
    const prefix = `RENDER_${slot.toUpperCase()}_${branch.toUpperCase()}`;
    const branchSuffix = branch.toUpperCase();
    return {
      apiKey: `${prefix}_API_KEY`,
      serviceId: `${prefix}_SERVICE_ID`,
      ownerId: `${prefix}_OWNER_ID`,
      registryCredentialId: `${prefix}_REGISTRY_CREDENTIAL_ID`,
      deployHookUrl: `RENDER_DEPLOY_HOOK_URL_${branchSuffix}`,
      healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branchSuffix}`,
    };
  }

  private parseRepoFullName(repoFullName: string): [string, string] {
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      throw new BadRequestException(
        `Invalid repoFullName '${repoFullName}'. Expected owner/repo.`,
      );
    }

    return [owner, repo];
  }

  private async resolveRenderToken(input: {
    userId: string;
    providerConnectionId: string | null;
    target: DeploymentTargetSummary;
  }): Promise<string> {
    if (input.target.ownershipMode === 'flowci_managed') {
      const config = this.configService.getOrThrow<AppConfig>('app');
      const token = config.envProvisioning.flowciManaged.renderToken.trim();
      if (!token) {
        throw new InternalServerErrorException(
          'ALPHACI_RENDER_API_KEY is required for ALPHACI-managed Render deployments',
        );
      }

      return token;
    }

    if (!input.providerConnectionId) {
      throw new BadRequestException(
        'providerConnectionId is required for BYO Render deployment secrets',
      );
    }

    const connection =
      await this.providerConnectionsRepository.findActiveProviderConnection(
        input.providerConnectionId,
        input.userId,
      );
    if (!connection || connection.provider !== 'render') {
      throw new NotFoundException('Render provider connection not found');
    }

    return this.encryptionService.decrypt(connection.encryptedToken);
  }

  private async resolveRenderOwnerId(input: {
    userId: string;
    providerConnectionId: string | null;
    target: DeploymentTargetSummary;
  }): Promise<string> {
    const metadataOwnerId = this.providerMetadataString(
      input.target.providerMetadata,
      'renderOwnerId',
    );
    if (metadataOwnerId) {
      return metadataOwnerId;
    }

    if (input.target.ownershipMode === 'byo') {
      if (!input.providerConnectionId) {
        throw new BadRequestException(
          'providerConnectionId is required for BYO Render owner metadata',
        );
      }

      const connection =
        await this.providerConnectionsRepository.findActiveProviderConnection(
          input.providerConnectionId,
          input.userId,
        );
      if (!connection || connection.provider !== 'render') {
        throw new NotFoundException('Render provider connection not found');
      }

      const connectionOwnerId = this.providerMetadataString(
        connection.metadata,
        'ownerId',
      );
      if (connectionOwnerId) {
        return connectionOwnerId;
      }
    }

    const config = this.configService.getOrThrow<AppConfig>('app');
    const ownerId =
      config.envProvisioning.flowciManaged.renderOwnerId?.trim() ?? '';
    if (!ownerId) {
      throw new BadRequestException(
        'Render owner id is required for image deployment secrets',
      );
    }

    return ownerId;
  }

  private providerMetadataString(
    metadata: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = metadata[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private resolveRenderHealthcheckUrl(
    target: DeploymentTargetSummary,
  ): string | null {
    return (
      this.providerMetadataString(
        target.providerMetadata,
        'renderServiceUrl',
      ) ??
      this.providerMetadataString(target.providerMetadata, 'serviceUrl') ??
      this.providerMetadataString(target.providerMetadata, 'url')
    );
  }
}
