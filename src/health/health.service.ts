import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../kernel/db/supabase/supabase.service.js';
import type { AppConfig } from '../config/app.config.js';

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

export interface HealthResponse {
  status: HealthStatus;
  uptimeSeconds: number;
  checks: HealthChecks;
  deploy: HealthDeployInfo;
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
    };
  }
}
