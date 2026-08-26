export interface EnsureTeamResult {
  githubTeamId: string;
  githubTeamSlug: string;
}

export interface VerifyPermissionResult {
  hasAccess: boolean;
  permission?: string;
  hasUnapprovedGrant?: boolean;
}

/**
 * Repository-scoped GitHub Team access mapping (plan §1.7/§3.2). Every
 * repository gets its own dedicated team — never organization base
 * permissions, never a shared cross-repository team (source plan §5, §9
 * "least-privilege GitHub scope").
 */
export abstract class GithubTeamAccessProvider {
  abstract ensureTeam(input: {
    repositoryId: string;
    repoFullName: string;
    actingUserId: string;
  }): Promise<EnsureTeamResult>;

  abstract addMember(input: {
    orgLogin: string;
    githubTeamSlug: string;
    githubLogin: string;
    repoFullName: string;
    actingUserId: string;
  }): Promise<void>;

  abstract removeMember(input: {
    orgLogin: string;
    githubTeamSlug: string;
    githubLogin: string;
    repoFullName: string;
    actingUserId: string;
  }): Promise<void>;

  abstract verifyEffectivePermission(input: {
    repoFullName: string;
    githubLogin: string;
    expectedPermission: 'write';
    expectedTeamSlug?: string;
    actingUserId: string;
  }): Promise<VerifyPermissionResult>;
}
