import { BadGatewayException, Injectable } from '@nestjs/common';

import { GithubService } from '../../../github/index.js';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'cicd-workflow-product';

/**
 * Write-only GitHub configuration broker (plan §1.8). Secrets are sealed
 * with libsodium before leaving the process — reuses
 * GithubService.setActionsSecretStrict (the existing, already-tested sealed-
 * box + PUT implementation, see github.service.ts:1243) rather than
 * re-implementing libsodium sealed-box encryption a second time. Variables
 * are plain PUT/POST (no encryption needed).
 *
 * Token resolution: uses the acting user's GitHub App installation token
 * (GithubService.getInstallationAccessTokenForUser) — the same pragmatic,
 * documented limitation as GithubTeamAccessLiveProvider (see that file's
 * header comment). AlphaCI itself never persists the plaintext value
 * anywhere in this class.
 */
@Injectable()
export class GithubSecretsProvider {
  constructor(private readonly githubService: GithubService) {}

  async resolveInstallationToken(userId: string): Promise<string> {
    const token =
      await this.githubService.getInstallationAccessTokenForUser(userId);
    if (!token) {
      throw new BadGatewayException(
        'No GitHub App installation token available for the requesting user',
      );
    }
    return token;
  }

  async writeVariable(input: {
    token: string;
    owner: string;
    repo: string;
    name: string;
    value: string;
  }): Promise<void> {
    const patchRes = await fetch(
      `${GITHUB_API}/repos/${input.owner}/${input.repo}/actions/variables/${input.name}`,
      {
        method: 'PATCH',
        headers: this.headers(input.token),
        body: JSON.stringify({ name: input.name, value: input.value }),
      },
    );
    if (patchRes.ok) {
      return;
    }
    if (patchRes.status !== 404) {
      throw new BadGatewayException(
        `GitHub variable update failed (${String(patchRes.status)}): ${await patchRes.text()}`,
      );
    }

    const createRes = await fetch(
      `${GITHUB_API}/repos/${input.owner}/${input.repo}/actions/variables`,
      {
        method: 'POST',
        headers: this.headers(input.token),
        body: JSON.stringify({ name: input.name, value: input.value }),
      },
    );
    if (!createRes.ok) {
      throw new BadGatewayException(
        `GitHub variable creation failed (${String(createRes.status)}): ${await createRes.text()}`,
      );
    }
  }

  async deleteVariable(input: {
    token: string;
    owner: string;
    repo: string;
    name: string;
  }): Promise<void> {
    const res = await fetch(
      `${GITHUB_API}/repos/${input.owner}/${input.repo}/actions/variables/${input.name}`,
      { method: 'DELETE', headers: this.headers(input.token) },
    );
    if (!res.ok && res.status !== 404) {
      throw new BadGatewayException(
        `GitHub variable delete failed (${String(res.status)}): ${await res.text()}`,
      );
    }
  }

  async writeSecret(input: {
    token: string;
    owner: string;
    repo: string;
    name: string;
    value: string;
  }): Promise<void> {
    await this.githubService.setActionsSecretStrict(
      input.token,
      input.owner,
      input.repo,
      input.name,
      input.value,
    );
  }

  async deleteSecret(input: {
    token: string;
    owner: string;
    repo: string;
    name: string;
  }): Promise<void> {
    const res = await fetch(
      `${GITHUB_API}/repos/${input.owner}/${input.repo}/actions/secrets/${input.name}`,
      { method: 'DELETE', headers: this.headers(input.token) },
    );
    if (!res.ok && res.status !== 404) {
      throw new BadGatewayException(
        `GitHub secret delete failed (${String(res.status)}): ${await res.text()}`,
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
