export interface GithubInstallationContract {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
}
