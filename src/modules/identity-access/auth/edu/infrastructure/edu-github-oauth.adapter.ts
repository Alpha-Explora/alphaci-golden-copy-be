import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  EDU_AUTH_CONFIG,
  type EduAuthConfig,
  type EduGithubOAuthPort,
  type EduGithubProfile,
  type GithubTokenCheckResult,
} from '../application/edu-auth.ports.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Injectable()
export class EduGithubOAuthAdapter implements EduGithubOAuthPort {
  private readonly logger = new Logger(EduGithubOAuthAdapter.name);

  constructor(
    @Inject(EDU_AUTH_CONFIG) private readonly config: EduAuthConfig,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.githubClientId &&
      this.config.githubClientSecret &&
      this.config.githubCallbackUrl,
    );
  }

  authorizationUrl(state: string): string {
    const query = new URLSearchParams({
      client_id: this.config.githubClientId,
      redirect_uri: this.config.githubCallbackUrl,
      scope: this.config.githubScope,
      state,
    });
    return `https://github.com/login/oauth/authorize?${query.toString()}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.config.githubClientId,
          client_secret: this.config.githubClientSecret,
          code,
          redirect_uri: this.config.githubCallbackUrl,
        }),
      },
    );
    const payload = await this.json(response);
    const token = stringValue(payload.access_token);
    if (!response.ok || !token) {
      throw new Error('EDU GitHub OAuth token exchange failed');
    }
    return token;
  }

  async fetchProfile(accessToken: string): Promise<EduGithubProfile> {
    const response = await fetch('https://api.github.com/user', {
      headers: this.githubHeaders(accessToken),
    });
    const payload = await this.json(response);
    if (!response.ok) throw new Error('EDU GitHub profile lookup failed');

    const userId =
      typeof payload.id === 'number'
        ? String(payload.id)
        : stringValue(payload.id);
    const login = stringValue(payload.login);
    if (!userId || !login) throw new Error('EDU GitHub profile was incomplete');

    let email = stringValue(payload.email) ?? null;
    if (!email) email = await this.fetchPrimaryEmail(accessToken);

    return {
      userId,
      login,
      name: stringValue(payload.name) ?? null,
      email,
      avatarUrl: stringValue(payload.avatar_url) ?? null,
      profileUrl: stringValue(payload.html_url) ?? null,
    };
  }

  async checkToken(accessToken: string): Promise<GithubTokenCheckResult> {
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: this.githubHeaders(accessToken),
      });
      if (response.status === 401) return { ok: false, reason: 'revoked' };
      if (!response.ok) return { ok: false, reason: 'failed' };
      const payload = await this.json(response);
      const login = stringValue(payload.login);
      if (!login) return { ok: false, reason: 'failed' };
      const scopes = (response.headers.get('x-oauth-scopes') ?? '')
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);
      return { ok: true, login, scopes };
    } catch (error) {
      this.logger.warn(
        `EDU GitHub status check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: 'failed' };
    }
  }

  private async fetchPrimaryEmail(accessToken: string): Promise<string | null> {
    try {
      const response = await fetch('https://api.github.com/user/emails', {
        headers: this.githubHeaders(accessToken),
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json().catch(() => []);
      if (!Array.isArray(payload)) return null;
      const primary: unknown = payload.find(
        (entry: unknown) =>
          isRecord(entry) &&
          entry.primary === true &&
          typeof entry.email === 'string',
      );
      return isRecord(primary) ? (stringValue(primary.email) ?? null) : null;
    } catch {
      return null;
    }
  }

  private githubHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'alphaci-edu-auth',
    };
  }

  private async json(response: Response): Promise<JsonRecord> {
    const payload: unknown = await response.json().catch(() => ({}));
    return isRecord(payload) ? payload : {};
  }
}
