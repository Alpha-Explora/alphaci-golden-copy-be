import { Injectable, Logger, Inject } from '@nestjs/common';

import {
  EDU_AUTH_CONFIG,
  type EduAuthConfig,
  type SupabaseAuthPort,
  type SupabasePasswordResult,
  type SupabaseSignUpResult,
} from '../application/edu-auth.ports.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

@Injectable()
export class EduSupabaseAuthAdapter implements SupabaseAuthPort {
  private readonly logger = new Logger(EduSupabaseAuthAdapter.name);

  constructor(
    @Inject(EDU_AUTH_CONFIG) private readonly config: EduAuthConfig,
  ) {}

  async verifyPassword(
    email: string,
    password: string,
  ): Promise<SupabasePasswordResult> {
    if (!this.isConfigured()) return { ok: false, reason: 'unconfigured' };

    try {
      const response = await fetch(
        `${this.baseUrl()}/auth/v1/token?grant_type=password`,
        {
          method: 'POST',
          headers: this.publicHeaders(),
          body: JSON.stringify({ email, password }),
        },
      );
      const payload = await this.json(response);

      if (!response.ok) {
        if (response.status === 429) {
          return { ok: false, reason: 'rate_limited' };
        }
        if (
          payload.error_code === 'email_not_confirmed' ||
          this.errorText(payload).toLowerCase().includes('confirm')
        ) {
          return { ok: false, reason: 'email_not_confirmed' };
        }
        if (response.status === 400 || response.status === 401) {
          return { ok: false, reason: 'invalid_credentials' };
        }
        this.logger.warn(
          `EDU Supabase password grant failed (${response.status})`,
        );
        return { ok: false, reason: 'error' };
      }

      const accessToken = stringValue(payload.access_token);
      const user = isRecord(payload.user) ? payload.user : undefined;
      const authUserId = user ? stringValue(user.id) : undefined;
      if (!accessToken || !authUserId) {
        this.logger.warn(
          'EDU Supabase password grant returned no access token or user id',
        );
        return { ok: false, reason: 'error' };
      }

      return {
        ok: true,
        user: {
          authUserId,
          email: stringValue(user?.email) ?? email,
          accessToken,
        },
      };
    } catch (error) {
      this.logger.error(
        `EDU Supabase Auth unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: 'error' };
    }
  }

  async signUp(email: string, password: string): Promise<SupabaseSignUpResult> {
    if (!this.isConfigured()) return { outcome: 'unconfigured' };

    try {
      const response = await fetch(`${this.baseUrl()}/auth/v1/signup`, {
        method: 'POST',
        headers: this.publicHeaders(),
        body: JSON.stringify({
          email,
          password,
          options: { email_redirect_to: this.config.supabaseSignupRedirectUrl },
        }),
      });
      const payload = await this.json(response);

      if (!response.ok) {
        if (response.status === 422) return { outcome: 'already-registered' };
        if (response.status === 429) return { outcome: 'rate-limited' };
        this.logger.warn(`EDU Supabase signup failed (${response.status})`);
        return { outcome: 'failed' };
      }

      const user = isRecord(payload.user) ? payload.user : undefined;
      return {
        outcome: 'created',
        authUserId: stringValue(user?.id) ?? stringValue(payload.id) ?? null,
        needsEmailConfirmation: !user?.confirmed_at,
      };
    } catch (error) {
      this.logger.error(
        `EDU Supabase signup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { outcome: 'failed' };
    }
  }

  async sendPasswordReset(email: string): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      const response = await fetch(`${this.baseUrl()}/auth/v1/recover`, {
        method: 'POST',
        headers: this.publicHeaders(),
        body: JSON.stringify({
          email,
          redirect_to: this.config.supabasePasswordResetRedirectUrl,
        }),
      });
      if (!response.ok) {
        this.logger.warn(
          `EDU Supabase recover returned ${response.status} for a reset request`,
        );
      }
    } catch (error) {
      this.logger.error(
        `EDU Supabase recover failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async setPasswordWithToken(
    accessToken: string,
    password: string,
  ): Promise<string | null> {
    if (!this.isConfigured()) {
      return 'Password sign-in is not configured on this server.';
    }

    try {
      const response = await fetch(`${this.baseUrl()}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          ...this.publicHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ password }),
      });
      if (response.ok) return null;
      if (response.status === 401 || response.status === 403) {
        return 'This link has expired or has already been used. Request a new one.';
      }

      const payload = await this.json(response);
      return (
        stringValue(payload.msg) ??
        stringValue(payload.message) ??
        'That password could not be saved. Please try again.'
      );
    } catch (error) {
      this.logger.error(
        `EDU Supabase set-password failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'We could not reach the sign-in service. Try again in a moment.';
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.config.supabaseUrl && this.config.supabaseAnonKey);
  }

  private baseUrl(): string {
    return this.config.supabaseUrl.replace(/\/+$/u, '');
  }

  private publicHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      apikey: this.config.supabaseAnonKey,
      Authorization: `Bearer ${this.config.supabaseAnonKey}`,
    };
  }

  private async json(response: Response): Promise<JsonRecord> {
    const payload: unknown = await response.json().catch(() => ({}));
    return isRecord(payload) ? payload : {};
  }

  private errorText(payload: JsonRecord): string {
    return [
      payload.error_code,
      payload.error_description,
      payload.msg,
      payload.message,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }
}
