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
} from './github-team-access.provider';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'cicd-workflow-product';

/**
 * Real Octokit-equivalent calls (plain fetch, matching this codebase's
 * existing GithubService style — no Octokit SDK dependency here). NOT
 * exercised by default: HIERARCHY_GITHUB_SYNC_MODE defaults to 'stub' in
 * every environment (plan §1.7); this class only runs once an operator
 * explicitly opts an environment into 'live'.
 *
 * Known limitation (documented, not silently incurred): resolving the
 * "centrally governed GitHub App credential" (source plan §5) ideally uses
 * an org-level installation lookup independent of any one user. This
 * module cannot add that lookup without modifying
 * GithubInstallationsRepository (out of scope — plan §3.2 restricts GitHub
 * module changes to *calling* existing public methods). Instead, the caller
 * supplies the acting PM's userId and this provider resolves their
 * installation token via the existing
 * GithubService.getInstallationAccessTokenForUser. This is adequate for a
 * pilot (source plan Phase 6) but should be revisited before broad rollout.
 */
@Injectable()
export class GithubTeamAccessLiveProvider extends GithubTeamAccessProvider {
  private readonly logger = new Logger(GithubTeamAccessLiveProvider.name);

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

  async verifyEffectivePermission(input: {
    repoFullName: string;
    githubLogin: string;
    expectedPermission: 'write';
    expectedTeamSlug?: string;
    actingUserId: string;
  }): Promise<VerifyPermissionResult> {
    const token = await this.requireToken(
      input.actingUserId,
      input.repoFullName,
    );
    const res = await fetch(
      `${GITHUB_API}/repos/${input.repoFullName}/collaborators/${input.githubLogin}/permission`,
      { headers: this.headers(token) },
    );
    if (!res.ok) {
      if (res.status === 404) {
        return { hasAccess: false };
      }
      throw new BadGatewayException(
        `GitHub permission verification failed (${String(res.status)}): ${await res.text()}`,
      );
    }
    const payload = (await res.json()) as { permission: string };
    const hasAccess = payload.permission !== 'none';
    const hasUnapprovedGrant = await this.hasUnapprovedGrant({
      repoFullName: input.repoFullName,
      githubLogin: input.githubLogin,
      ...(input.expectedTeamSlug !== undefined && {
        expectedTeamSlug: input.expectedTeamSlug,
      }),
      token,
    });
    return {
      hasAccess,
      permission: payload.permission,
      hasUnapprovedGrant:
        hasUnapprovedGrant || payload.permission !== input.expectedPermission,
    };
  }

  private async hasUnapprovedGrant(input: {
    repoFullName: string;
    githubLogin: string;
    expectedTeamSlug?: string;
    token: string;
  }): Promise<boolean> {
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
      return true;
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
      if (membershipRes.ok) return true;
      if (membershipRes.status !== 404) {
        throw new BadGatewayException(
          `GitHub inherited team verification failed (${String(membershipRes.status)}): ${await membershipRes.text()}`,
        );
      }
    }
    return false;
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

  private async requireToken(
    actingUserId: string,
    repoFullName: string,
  ): Promise<string> {
    const token =
      await this.githubService.getInstallationAccessTokenForUserRepo(
        actingUserId,
        repoFullName,
      );
    if (!token) {
      throw new BadGatewayException(
        'No GitHub App installation token available for the acting user',
      );
    }
    return token;
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
