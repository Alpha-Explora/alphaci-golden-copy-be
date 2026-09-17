import { BadRequestException, Injectable } from '@nestjs/common';

import type {
  DeploymentTargetSummary,
  EnvTargetSlot,
} from '../../../core/deployments.types';
import type {
  ProviderCiSecretsInstaller,
  ProviderCiSecretsInstallerInput,
} from '../../../application/ports/provider-ci-secrets-installer.port';
import {
  GITHUB_ACTIONS_SECRETS,
  type GithubActionsSecretsPort,
} from '../../../application/ports/github-actions-secrets.port';
import { Inject } from '@nestjs/common';
import { RENDER_SERVICE_BRANCHES, renderBranchFor } from './render-conventions';

export interface RenderCiSecretNames {
  [key: string]: string;
  healthcheckUrl: string;
}

@Injectable()
export class RenderCiSecretsService implements ProviderCiSecretsInstaller {
  readonly provider = 'render';

  // Only the GitHub port remains: with no credential to resolve, the Render
  // connection repository, the token decryptor and the configuration this used
  // to read are no longer anything this class needs.
  constructor(
    @Inject(GITHUB_ACTIONS_SECRETS)
    private readonly githubService: GithubActionsSecretsPort,
  ) {}

  supports(target: DeploymentTargetSummary): boolean {
    return (
      target.provider === this.provider &&
      ['render_image_pushed', 'render_existing_service'].includes(
        target.deploymentStrategy,
      )
    );
  }

  async installForTarget(
    input: ProviderCiSecretsInstallerInput,
  ): Promise<{ githubSecrets: Record<string, string> }> {
    if (!this.supports(input.target)) {
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

    /*
     * Only the service address, never a credential.
     *
     * This used to install the platform's Render API key, plus the service and
     * owner ids, into every customer repository. A Render key is issued on an
     * account and cannot be scoped to one service, so anyone able to push a
     * workflow to any generated repository could manage - or delete - every
     * service on the account, including this platform's own. Nothing read them
     * either: the deploy job never used them, and now the platform performs
     * the release itself, so there is nothing they could be for.
     */
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
    branchName: string | null | undefined = RENDER_SERVICE_BRANCHES[0],
  ): RenderCiSecretNames {
    // Shared with the workflow generator: the names written here and the names
    // the generated jobs read are the same function, so a branch cannot be
    // installed under one spelling and read under another.
    const branch = renderBranchFor(branchName);
    return {
      healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branch.toUpperCase()}`,
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
