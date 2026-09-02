import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { EnvTokenEncryptionService } from '../../../application/encryption.service';
import type {
  DeploymentTargetSummary,
  EnvTargetSlot,
} from '../../../core/deployments.types';
import { ProviderConnectionsRepository } from '../../repositories/provider-connections.repository';
import type {
  ProviderCiSecretsInstaller,
  ProviderCiSecretsInstallerInput,
} from '../../../application/ports/provider-ci-secrets-installer.port';
import {
  GITHUB_ACTIONS_SECRETS,
  type GithubActionsSecretsPort,
} from '../../../application/ports/github-actions-secrets.port';
import { Inject } from '@nestjs/common';

export interface InstallVercelCiSecretsInput {
  githubAccessToken: string;
  repoFullName: string;
  userId: string;
  providerConnectionId: string | null;
  target: DeploymentTargetSummary;
}

export interface VercelCiSecretNames {
  [key: string]: string;
  token: string;
  orgId: string;
  projectId: string;
}

@Injectable()
export class VercelCiSecretsService implements ProviderCiSecretsInstaller {
  readonly provider = 'vercel';

  constructor(
    @Inject(GITHUB_ACTIONS_SECRETS)
    private readonly githubService: GithubActionsSecretsPort,
    private readonly providerConnectionsRepository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    private readonly configService: ConfigService,
  ) {}

  supports(target: DeploymentTargetSummary): boolean {
    return (
      target.provider === this.provider &&
      target.deploymentStrategy === 'vercel_ci_pushed'
    );
  }

  async installForTarget(
    input: ProviderCiSecretsInstallerInput,
  ): Promise<{ githubSecrets: Record<string, string> }> {
    if (!this.supports(input.target)) {
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
