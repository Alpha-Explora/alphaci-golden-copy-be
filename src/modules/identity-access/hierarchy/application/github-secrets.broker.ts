export const GITHUB_SECRETS_BROKER = Symbol('GithubSecretsBroker');

export interface GithubSecretsWriteInput {
  token: string;
  owner: string;
  repo: string;
  name: string;
  value: string;
}

export interface GithubSecretsDeleteInput {
  token: string;
  owner: string;
  repo: string;
  name: string;
}

export interface GithubSecretsBroker {
  resolveInstallationToken(userId: string): Promise<string>;
  writeVariable(input: GithubSecretsWriteInput): Promise<void>;
  writeSecret(input: GithubSecretsWriteInput): Promise<void>;
  deleteVariable(input: GithubSecretsDeleteInput): Promise<void>;
  deleteSecret(input: GithubSecretsDeleteInput): Promise<void>;
}
