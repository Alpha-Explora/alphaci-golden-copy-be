import type { DeploymentTargetSummary } from '../../core/deployments.types';

/**
 * Provider-owned GitHub Actions secret installation.
 *
 * Provisioning orchestration must not know which provider-specific secret
 * names, credentials, or deployment strategy are required. A provider plugin
 * opts into this port when it owns a CI-pushed deployment path.
 */
export interface ProviderCiSecretsInstallerInput {
  githubAccessToken: string;
  repoFullName: string;
  userId: string;
  providerConnectionId: string | null;
  target: DeploymentTargetSummary;
}

/**
 * What a provider installed, by name.
 *
 * `githubVariables` is optional so a provider that has no addresses to publish
 * does not have to say so, and so the two kinds can never be confused at the
 * call site: a value that appears under `githubSecrets` is unreadable
 * afterwards, while one under `githubVariables` is public by construction.
 */
export interface ProviderCiSecretsInstallResult {
  githubSecrets: Record<string, string>;
  githubVariables?: Record<string, string>;
}

export interface ProviderCiSecretsInstaller {
  readonly provider: string;
  supports(target: DeploymentTargetSummary): boolean;
  installForTarget(
    input: ProviderCiSecretsInstallerInput,
  ): Promise<ProviderCiSecretsInstallResult>;
}

export const PROVIDER_CI_SECRETS_INSTALLERS = Symbol(
  'ProviderCiSecretsInstallers',
);

export const PROVIDER_CI_SECRETS_INSTALLER_REGISTRY = Symbol(
  'ProviderCiSecretsInstallerRegistry',
);

export interface ProviderCiSecretsInstallerRegistryPort {
  get(provider: string): ProviderCiSecretsInstaller | undefined;
}
