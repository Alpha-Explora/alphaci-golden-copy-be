/**
 * Narrow runtime-facing seam for provider plugins that install GitHub Actions
 * configuration. The provider implementations do not depend on the pipelines
 * context's concrete GithubService.
 *
 * Carries both kinds because a provider needs both: credentials go in as
 * secrets, and the addresses a later pipeline stage must be handed go in as
 * variables — a stage triggered by `workflow_run` can be given a variable but
 * never a secret. The symbol keeps its original name so existing injection
 * sites are untouched.
 */
export interface GithubActionsSecretsPort {
  setActionsSecretStrict(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void>;
  setActionsVariableStrict(
    accessToken: string,
    owner: string,
    repo: string,
    variableName: string,
    variableValue: string,
  ): Promise<void>;
}

export const GITHUB_ACTIONS_SECRETS = Symbol('GithubActionsSecrets');
