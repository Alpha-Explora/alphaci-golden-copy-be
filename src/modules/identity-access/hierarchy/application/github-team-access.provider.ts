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
 * Repository-scoped GitHub Team access mapping (GitHub access contract). Every
 * repository gets its own dedicated team — never organization base
 * permissions, never a shared cross-repository team (hierarchy retry and security contract
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
    /**
     * `grant` (default): the person must hold Write or more.
     * `revoke`: the person must no longer hold access through the repository
     * team (the org base permission stays `read`, so "none" is never expected).
     */
    intent?: 'grant' | 'revoke';
    /**
     * True only when ALPHACI created this repository AND this person is the
     * recorded creator. GitHub gives such a creator a direct admin
     * collaborator grant automatically; that one grant (for that repository
     * and person only) is expected, not drift.
     */
    isRepositoryCreator?: boolean;
    actingUserId: string;
  }): Promise<VerifyPermissionResult>;
}
