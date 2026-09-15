import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '#kernel/db/supabase/supabase.service.js';
import type { AppConfig } from '#kernel/config/app.config.js';

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface HealthChecks {
  database: boolean;
  apiCenter: boolean;
}

export interface HealthDeployInfo {
  /** Render sets this automatically per deploy — compare against the branch
   * tip to confirm a redeploy actually picked up the expected commit. */
  gitCommit: string;
  githubEnforcedOrg: string;
  /** Ground-truth view of the GitHub App wiring the RUNNING process sees.
   * githubAppConfigured mirrors GithubService.hasAppCredentials() (App ID +
   * private key both present); appId/slug are public identifiers, not secrets.
   * Lets a deployment confirm the App creds actually loaded without exposing
   * the private key or reading logs. */
  githubAppConfigured: boolean;
  githubAppId: string;
  githubAppSlug: string;
}

/**
 * Whether the RUNNING process has credentials for each hosting provider.
 *
 * Booleans only - never the tokens, never a prefix of them. The question this
 * answers is "is hosting configured here", and that needs one bit per
 * provider.
 *
 * It exists because answering it cost a source dive. A React project was
 * created with three Vercel deploy jobs in its repository and no Vercel
 * project behind them; the provisioning failure was a warn line on a server,
 * so establishing whether the token was even set meant reading the
 * provisioning code and inferring from what it did not do. One request should
 * answer it.
 */
export interface HealthProviderInfo {
  renderConfigured: boolean;
  vercelConfigured: boolean;
  /**
   * Whether managed Vercel provisioning can actually run.
   *
   * Managed Vercel needs a team id as well as a token - resolveConnectionScope
   * rejects the request without one - so vercelConfigured being true does not
   * mean a managed target can be created. Reading it as though it did is the
   * mistake this field exists to prevent. Render needs only its API key, so
   * renderConfigured already answers both questions there.
   *
   * Configuration only. Whether that team accepts that token is Vercel's
   * answer to give, and this endpoint is unauthenticated and polled, so it
   * does not ask.
   */
  vercelManagedReady: boolean;
}

export interface HealthResponse {
  status: HealthStatus;
  uptimeSeconds: number;
  checks: HealthChecks;
  deploy: HealthDeployInfo;
  providers: HealthProviderInfo;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: ConfigService,
  ) {}

  async getStatus(): Promise<HealthResponse> {
    const [dbResult] = await Promise.allSettled([this.supabaseService.ping()]);

    const database = dbResult.status === 'fulfilled' ? dbResult.value : false;

    const status: HealthStatus = database ? 'ok' : 'error';
    const github = this.configService.get<AppConfig>('app')?.github;
    const managed =
      this.configService.get<AppConfig>('app')?.envProvisioning?.flowciManaged;

    return {
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database, apiCenter: true },
      deploy: {
        gitCommit: process.env['RENDER_GIT_COMMIT'] ?? 'unknown',
        githubEnforcedOrg: github?.enforcedOrg || '(empty)',
        githubAppConfigured: Boolean(github?.appId && github?.appPrivateKey),
        githubAppId: github?.appId || '(empty)',
        githubAppSlug: github?.appSlug || '(empty)',
      },
      providers: {
        renderConfigured: Boolean(managed?.renderToken?.trim()),
        vercelConfigured: Boolean(managed?.vercelToken?.trim()),
        vercelManagedReady: Boolean(
          managed?.vercelToken?.trim() && managed?.vercelTeamId?.trim(),
        ),
      },
    };
  }
}
