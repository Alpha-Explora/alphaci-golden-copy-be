export interface GoogleProfile {
  providerUserId: string;
  email: string;
  emailVerified: true;
  name?: string;
  avatarUrl?: string;
}

export interface GoogleOAuthPort {
  isConfigured(): boolean;
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<GoogleProfile>;
}

export const GOOGLE_OAUTH = Symbol('GOOGLE_OAUTH');
