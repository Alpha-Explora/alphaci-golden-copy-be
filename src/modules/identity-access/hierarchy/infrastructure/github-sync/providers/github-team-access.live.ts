import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';

import {
  GITHUB_ORGANIZATION_PORT,
  type GithubOrganizationPort,
} from '#kernel/ports/github.port';
import {
  GithubTeamAccessProvider,
  type EnsureTeamResult,
  type VerifyPermissionResult,
} from '../../../application/github-team-access.provider';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'cicd-workflow-product';
/** Well under the one-hour installation token lifetime. */
const TOKEN_CACHE_MS = 5 * 60 * 1000;

const WRITE_OR_ABOVE = new Set(['write', 'maintain', 'admin']);
/** Roles that already exceed Write; never a verification failure. */
const ABOVE_WRITE = new Set(['maintain', 'admin']);

/**
 * Real Octokit-equivalent calls (plain fetch, matching this codebase's
 * existing GithubService style — no Octokit SDK dependency here). NOT
 * exercised by default: HIERARCHY_GITHUB_SYNC_MODE defaults to 'stub' in
 * every environment (explicit GitHub sync configuration); this class only runs once an operator
 * explicitly opts an environment into 'live'.
 *
 * Credential: the ALPHACI GitHub App's ORGANIZATION installation token,
 * resolved app-to-org through GithubOrganizationPort
 * .getOrganizationProvisioningContextByLogin. It is independent of any one
 * user (production has no per-user installation rows), so a grant never
 * depends on who clicked.
 */
@Injectable()
export class GithubTeamAccessLiveProvider extends GithubTeamAccessProvider {
  private readonly logger = new Logger(GithubTeamAccessLiveProvider.name);
  /** Installation tokens live an hour; a job makes several calls, mint once. */
  private readonly tokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(
    @Inject(GITHUB_ORGANIZATION_PORT)
    private readonly githubService: GithubOrganizationPort,
  ) {
    super();
  }

  async ensureTeam(input: {
    repositoryId: string;
    repoFullName: string;
    actingUserId: string;
  }): Promise<EnsureTeamResult> {
    const [orgLogin, repoName] = input.repoFullName.split('/');
    if (!orgLogin || !repoName) {
      throw new BadGatewayException(
        `Malformed repoFullName for team ensure: ${input.repoFullName}`,
      );
    }
    const token = await this.requireToken(
      input.actingUserId,
      input.repoFullName,
    );
    const teamSlug = `${repoName}-developers`.toLowerCase();

    const createRes = await fetch(`${GITHUB_API}/orgs/${orgLogin}/teams`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        name: teamSlug,
        privacy: 'closed',
      }),
    });

    // 422 = team already exists (name collision) — fetch it instead of failing.
    if (!createRes.ok && createRes.status !== 422) {
      throw new BadGatewayException(
        `GitHub team creation failed (${String(createRes.status)}): ${await createRes.text()}`,
      );
    }

    const teamPayload = createRes.ok
      ? ((await createRes.json()) as { id: number; slug: string })
      : await this.fetchExistingTeam(orgLogin, teamSlug, token);

    const repoGrantRes = await fetch(
      `${GITHUB_API}/orgs/${orgLogin}/teams/${teamPayload.slug}/repos/${orgLogin}/${repoName}`,
      {
        method: 'PUT',
        headers: this.headers(token),
        body: JSON.stringify({ permission: 'push' }),
      },
    );
    if (!repoGrantRes.ok) {
      throw new BadGatewayException(
        `GitHub team-repo grant failed (${String(repoGrantRes.status)}): ${await repoGrantRes.text()}`,
      );
    }

    return {
      githubTeamId: String(teamPayload.id),
      githubTeamSlug: teamPayload.slug,
    };
  }

  async addMember(input: {
    orgLogin: string;
    githubTeamSlug: string;
    githubLogin: string;
    repoFullName: string;
    actingUserId: string;
  }): Promise<void> {
    const token = await this.requireToken(
      input.actingUserId,
      input.repoFullName,
    );
    const res = await fetch(
      `${GITHUB_API}/orgs/${input.orgLogin}/teams/${input.githubTeamSlug}/memberships/${input.githubLogin}`,
      {
        method: 'PUT',
        headers: this.headers(token),
        body: JSON.stringify({ role: 'member' }),
      },
    );
    if (!res.ok) {
      throw new BadGatewayException(
        `GitHub team member add failed (${String(res.status)}): ${await res.text()}`,
      );
    }
  }

  async removeMember(input: {
    orgLogin: string;
    githubTeamSlug: string;
    githubLogin: string;
    repoFullName: string;
    actingUserId: string;
  }): Promise<void> {
    const token = await this.requireToken(
      input.actingUserId,
      input.repoFullName,
    );
    const res = await fetch(
      `${GITHUB_API}/orgs/${input.orgLogin}/teams/${input.githubTeamSlug}/memberships/${input.githubLogin}`,
      { method: 'DELETE', headers: this.headers(token) },
    );
    if (!res.ok && res.status !== 404) {
      throw new BadGatewayException(
        `GitHub team member remove failed (${String(res.status)}): ${await res.text()}`,
      );
    }

    // A direct collaborator grant is never approved by the hierarchy model.
    // Remove it as part of revocation as well as the repository-scoped team.
    const collaboratorRes = await fetch(
      `${GITHUB_API}/repos/${input.repoFullName}/collaborators/${input.githubLogin}`,
      { method: 'DELETE', headers: this.headers(token) },
    );
    if (!collaboratorRes.ok && collaboratorRes.status !== 404) {
      throw new BadGatewayException(
        `GitHub direct collaborator removal failed (${String(collaboratorRes.status)}): ${await collaboratorRes.text()}`,
      );
    }
  }

  /**
   * Grant intent: the user must hold Write (or more: maintain/admin, e.g. a
   * repository creator or an org owner, which the team grant cannot and need
   * not lower) and nothing unapproved beyond the repository team.
   *
   * Revoke intent: the org base permission is `read`, so "no access" cannot
   * mean `permission === 'none'`. Access is gone when the person is no longer
   * in the repository team, is not a direct collaborator, and holds no
   * Write-or-above through another team. A remaining `admin` that comes from
   * org ownership is not ours to remove and does not fail the revoke.
   */
  async verifyEffectivePermission(input: {
    repoFullName: string;
    githubLogin: string;
    expectedPermission: 'write';
    expectedTeamSlug?: string;
    intent?: 'grant' | 'revoke';
    actingUserId: string;
  }): Promise<VerifyPermissionResult> {
    const token = await this.requireToken(
      input.actingUserId,
      input.repoFullName,
    );
    const permissionRes = await fetch(
      `${GITHUB_API}/repos/${input.repoFullName}/collaborators/${input.githubLogin}/permission`,
      { headers: this.headers(token) },
    );
    let role = 'none';
    if (permissionRes.ok) {
      const payload = (await permissionRes.json()) as {
        permission?: string;
        role_name?: string;
      };
      // role_name distinguishes maintain/triage, which `permission` collapses.
      role = (payload.role_name ?? payload.permission ?? 'none').toLowerCase();
    } else if (permissionRes.status !== 404) {
      throw new BadGatewayException(
        `GitHub permission verification failed (${String(permissionRes.status)}): ${await permissionRes.text()}`,
      );
    }
    const atLeastWrite = WRITE_OR_ABOVE.has(role);

    if (input.intent === 'revoke') {
      return this.verifyRevoked(input, token, role, atLeastWrite);
    }

    if (!atLeastWrite) {
      return { hasAccess: false, permission: role };
    }
    if (ABOVE_WRITE.has(role)) {
      // Already above Write through a route the team grant does not control
      // (repository creator, org owner). Not a verification failure.
      return { hasAccess: true, permission: role, hasUnapprovedGrant: false };
    }
    const grants = await this.findUnapprovedGrants({
      repoFullName: input.repoFullName,
      githubLogin: input.githubLogin,
      ...(input.expectedTeamSlug !== undefined && {
        expectedTeamSlug: input.expectedTeamSlug,
      }),
      token,
    });
    return {
      hasAccess: true,
      permission: role,
      hasUnapprovedGrant: grants.direct || grants.otherTeam,
    };
  }

  private async verifyRevoked(
    input: {
      repoFullName: string;
      githubLogin: string;
      expectedTeamSlug?: string;
    },
    token: string,
    role: string,
    atLeastWrite: boolean,
  ): Promise<VerifyPermissionResult> {
    const [orgLogin] = input.repoFullName.split('/');
    let stillInTeam = false;
    if (input.expectedTeamSlug) {
      const membershipRes = await fetch(
        `${GITHUB_API}/orgs/${orgLogin ?? ''}/teams/${input.expectedTeamSlug}/memberships/${input.githubLogin}`,
        { headers: this.headers(token) },
      );
      if (membershipRes.ok) {
        stillInTeam = true;
      } else if (membershipRes.status !== 404) {
        throw new BadGatewayException(
          `GitHub team membership verification failed (${String(membershipRes.status)}): ${await membershipRes.text()}`,
        );
      }
    }
    const grants = await this.findUnapprovedGrants({
      repoFullName: input.repoFullName,
      githubLogin: input.githubLogin,
      ...(input.expectedTeamSlug !== undefined && {
        expectedTeamSlug: input.expectedTeamSlug,
      }),
      token,
    });
    const hasAccess =
      stillInTeam || grants.direct || (atLeastWrite && grants.otherTeam);
    return { hasAccess, permission: role };
  }

  private async findUnapprovedGrants(input: {
    repoFullName: string;
    githubLogin: string;
    expectedTeamSlug?: string;
    token: string;
  }): Promise<{ direct: boolean; otherTeam: boolean }> {
    const directRes = await fetch(
      `${GITHUB_API}/repos/${input.repoFullName}/collaborators?affiliation=direct&per_page=100`,
      { headers: this.headers(input.token) },
    );
    if (!directRes.ok) {
      throw new BadGatewayException(
        `GitHub direct collaborator verification failed (${String(directRes.status)}): ${await directRes.text()}`,
      );
    }
    const direct = (await directRes.json()) as Array<{ login: string }>;
    if (
      direct.some(
        (user) => user.login.toLowerCase() === input.githubLogin.toLowerCase(),
      )
    ) {
      return { direct: true, otherTeam: false };
    }

    const teamsRes = await fetch(
      `${GITHUB_API}/repos/${input.repoFullName}/teams?per_page=100`,
      { headers: this.headers(input.token) },
    );
    if (!teamsRes.ok) {
      throw new BadGatewayException(
        `GitHub repository team verification failed (${String(teamsRes.status)}): ${await teamsRes.text()}`,
      );
    }
    const teams = (await teamsRes.json()) as Array<{ slug: string }>;
    const [orgLogin] = input.repoFullName.split('/');
    for (const team of teams) {
      if (team.slug === input.expectedTeamSlug) continue;
      const membershipRes = await fetch(
        `${GITHUB_API}/orgs/${orgLogin ?? ''}/teams/${team.slug}/memberships/${input.githubLogin}`,
        { headers: this.headers(input.token) },
      );
      if (membershipRes.ok) return { direct: false, otherTeam: true };
      if (membershipRes.status !== 404) {
        throw new BadGatewayException(
          `GitHub inherited team verification failed (${String(membershipRes.status)}): ${await membershipRes.text()}`,
        );
      }
    }
    return { direct: false, otherTeam: false };
  }

  private async fetchExistingTeam(
    orgLogin: string,
    teamSlug: string,
    token: string,
  ): Promise<{ id: number; slug: string }> {
    const res = await fetch(
      `${GITHUB_API}/orgs/${orgLogin}/teams/${teamSlug}`,
      { headers: this.headers(token) },
    );
    if (!res.ok) {
      throw new BadGatewayException(
        `GitHub team lookup failed (${String(res.status)}): ${await res.text()}`,
      );
    }
    return (await res.json()) as { id: number; slug: string };
  }

  /**
   * The org installation token for the repository's owner. `actingUserId` is
   * kept in the provider contract for audit symmetry but is deliberately not
   * used to pick a credential.
   */
  private async requireToken(
    _actingUserId: string,
    repoFullName: string,
  ): Promise<string> {
    const [owner] = repoFullName.split('/');
    if (!owner) {
      throw new BadGatewayException(
        `Malformed repoFullName for GitHub token: ${repoFullName}`,
      );
    }
    const key = owner.toLowerCase();
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    try {
      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          owner,
        );
      this.tokenCache.set(key, {
        token: context.accessToken,
        expiresAt: Date.now() + TOKEN_CACHE_MS,
      });
      return context.accessToken;
    } catch (error) {
      this.tokenCache.delete(key);
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `No GitHub App organization token for ${owner}: ${reason}`,
      );
      throw new BadGatewayException(
        `No GitHub App organization installation token available for ${owner}: ${reason}`,
      );
    }
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    };
  }
}
