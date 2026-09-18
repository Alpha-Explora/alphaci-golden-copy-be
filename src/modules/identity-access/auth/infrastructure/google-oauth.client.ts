import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

import type { AppConfig } from '#kernel/config/app.config.js';
import type {
  GoogleOAuthPort,
  GoogleProfile,
} from '../application/google-oauth.port.js';

@Injectable()
export class GoogleOAuthClient implements GoogleOAuthPort {
  private readonly config: AppConfig['google'];
  private readonly client: OAuth2Client | null;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig>('app').google;
    this.client = this.config
      ? new OAuth2Client(
          this.config.clientId,
          this.config.clientSecret,
          this.config.callbackUrl,
        )
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  authorizationUrl(state: string): string {
    const client = this.requireClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    });
  }

  async exchangeCode(code: string): Promise<GoogleProfile> {
    const client = this.requireClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token || !this.config) {
      throw new Error('Google did not return an ID token');
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.config.clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new Error('Google account did not provide a verified email');
    }

    return {
      providerUserId: payload.sub,
      email: payload.email,
      emailVerified: true,
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.picture ? { avatarUrl: payload.picture } : {}),
    };
  }

  private requireClient(): OAuth2Client {
    if (!this.client) {
      throw new Error('Google OAuth is not configured');
    }
    return this.client;
  }
}
