/**
 * Narrow runtime-facing seam for provider plugins that install GitHub Actions
 * secrets. The provider implementations do not depend on the pipelines
 * context's concrete GithubService.
 */
export interface GithubActionsSecretsPort {
  setActionsSecretStrict(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void>;
}

export const GITHUB_ACTIONS_SECRETS = Symbol('GithubActionsSecrets');
