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

export interface InstallVercelCiSecretsInput {
  githubAccessToken: string;
  repoFullName: string;
  userId: string;
  providerConnectionId: string | null;
  target: DeploymentTargetSummary;
}

export interface VercelCiSecretNames {
  token: string;
  orgId: string;
  projectId: string;
}

@Injectable()
export class VercelCiSecretsService {
  constructor(
    private readonly githubService: GithubService,
    private readonly providerConnectionsRepository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    private readonly configService: ConfigService,
  ) {}

  async installForTarget(
    input: InstallVercelCiSecretsInput,
  ): Promise<{ githubSecrets: VercelCiSecretNames }> {
    if (
      input.target.provider !== 'vercel' ||
      input.target.deploymentStrategy !== 'vercel_ci_pushed'
    ) {
      return { githubSecrets: this.vercelSecretNames(input.target.slot) };
    }

    const [owner, repo] = this.parseRepoFullName(input.repoFullName);
    const secretNames = this.vercelSecretNames(input.target.slot);
    const vercelOrgId = this.requireProviderMetadataString(
      input.target.providerMetadata,
      'vercelOrgId',
    );
    const vercelToken = await this.resolveVercelToken(input);

    await this.githubService.setActionsSecretStrict(
      input.githubAccessToken,
      owner,
      repo,
      secretNames.token,
      vercelToken,
    );
    await this.githubService.setActionsSecretStrict(
      input.githubAccessToken,
      owner,
      repo,
      secretNames.orgId,
      vercelOrgId,
    );
    await this.githubService.setActionsSecretStrict(
      input.githubAccessToken,
      owner,
      repo,
      secretNames.projectId,
      input.target.providerProjectId,
    );

    return { githubSecrets: secretNames };
  }

  vercelSecretNames(slot: EnvTargetSlot): VercelCiSecretNames {
    const prefix = `VERCEL_${slot.toUpperCase()}`;
    return {
      token: `${prefix}_TOKEN`,
      orgId: `${prefix}_ORG_ID`,
      projectId: `${prefix}_PROJECT_ID`,
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

  private async resolveVercelToken(
    input: InstallVercelCiSecretsInput,
  ): Promise<string> {
    if (input.target.ownershipMode === 'flowci_managed') {
      const config = this.configService.getOrThrow<AppConfig>('app');
      const token = config.envProvisioning.flowciManaged.vercelToken.trim();
      if (!token) {
        throw new InternalServerErrorException(
          'ALPHACI_VERCEL_TOKEN is required for ALPHACI-managed Vercel deployments',
        );
      }

      return token;
    }

    if (!input.providerConnectionId) {
      throw new BadRequestException(
        'providerConnectionId is required for BYO Vercel deployment secrets',
      );
    }

    const connection =
      await this.providerConnectionsRepository.findActiveProviderConnection(
        input.providerConnectionId,
        input.userId,
      );
    if (!connection || connection.provider !== 'vercel') {
      throw new NotFoundException('Vercel provider connection not found');
    }

    return this.encryptionService.decrypt(connection.encryptedToken);
  }

  private requireProviderMetadataString(
    metadata: Record<string, unknown>,
    key: string,
  ): string {
    const value = metadata[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(
        `Vercel provider metadata is missing ${key}`,
      );
    }

    return value.trim();
  }
}
