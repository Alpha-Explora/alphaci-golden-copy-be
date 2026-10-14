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
  /**
   * Create or update the repository's GitHub Environment for a project
   * environment and allow deployments only from its source branch. Resolves
   * the app installation token itself; throws when the environment cannot be
   * provisioned, so no workflow can reference an unprotected environment.
   */
  ensureDeploymentEnvironment(input: {
    userId: string;
    repoFullName: string;
    environmentName: string;
    sourceBranch: string;
  }): Promise<void>;
  /** Dispatch a repository workflow with the app installation token; throws on refusal. */
  dispatchWorkflow(input: {
    userId: string;
    repoFullName: string;
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
}

export const GITHUB_ACTIONS_SECRETS = Symbol('GithubActionsSecrets');
