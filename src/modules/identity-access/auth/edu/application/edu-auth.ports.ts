import type { EduAccount, EduLab, EduRole } from '../model/edu-auth.types.js';

export const EDU_AUTH_CONFIG = Symbol('EDU_AUTH_CONFIG');
export const EDU_AUTH_REPOSITORY = Symbol('EDU_AUTH_REPOSITORY');
export const SUPABASE_AUTH_PORT = Symbol('SUPABASE_AUTH_PORT');
export const EDU_GITHUB_OAUTH_PORT = Symbol('EDU_GITHUB_OAUTH_PORT');

export class EduGithubLinkConflictError extends Error {
  constructor() {
    super('That GitHub account is already linked to another EDU account.');
    this.name = 'EduGithubLinkConflictError';
  }
}

export interface EduAuthConfig {
  enabled: boolean;
  frontendUrl: string;
  sessionCookieName: string;
  studentEmailDomains: string[];
  studentJitProvisioningEnabled: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabasePasswordResetRedirectUrl: string;
  supabaseSignupRedirectUrl: string;
  githubClientId: string;
  githubClientSecret: string;
  githubCallbackUrl: string;
  githubScope: string;
}

export type SupabasePasswordResult =
  | {
      ok: true;
      user: {
        authUserId: string;
        email: string;
        accessToken: string;
      };
    }
  | {
      ok: false;
      reason:
        | 'invalid_credentials'
        | 'email_not_confirmed'
        | 'rate_limited'
        | 'unconfigured'
        | 'error';
    };

export type SupabaseSignUpResult =
  | {
      outcome: 'created';
      authUserId: string | null;
      needsEmailConfirmation: boolean;
    }
  | { outcome: 'already-registered' }
  | { outcome: 'rate-limited' }
  | { outcome: 'unconfigured' }
  | { outcome: 'failed' };

export interface SupabaseAuthPort {
  verifyPassword(
    email: string,
    password: string,
  ): Promise<SupabasePasswordResult>;
  signUp(email: string, password: string): Promise<SupabaseSignUpResult>;
  sendPasswordReset(email: string): Promise<void>;
  setPasswordWithToken(
    accessToken: string,
    password: string,
  ): Promise<string | null>;
}

export interface EduGithubProfile {
  userId: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
}

export type GithubTokenCheckResult =
  | { ok: true; login: string; scopes: string[] }
  | { ok: false; reason: 'revoked' | 'failed' };

export interface EduGithubOAuthPort {
  isConfigured(): boolean;
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
  fetchProfile(accessToken: string): Promise<EduGithubProfile>;
  checkToken(accessToken: string): Promise<GithubTokenCheckResult>;
}

export interface CreateEduStudentInput {
  email: string;
  authUserId: string;
  fullName: string;
  homeLabId: string;
}

export interface LinkEduGithubInput {
  userId: string;
  githubUserId: string;
  githubLogin: string;
  githubAvatarUrl: string | null;
  githubProfileUrl: string | null;
}

export interface EduAuthRepositoryPort {
  findBySupabaseUserId(authUserId: string): Promise<EduAccount | null>;
  findByUserId(userId: string): Promise<EduAccount | null>;
  findByEmail(email: string): Promise<EduAccount | null>;
  findFirstActiveLab(): Promise<EduLab | null>;
  createStudent(input: CreateEduStudentInput): Promise<EduAccount>;
  recordSupabaseLogin(authUserId: string, email: string): Promise<void>;
  listAccessibleLabs(userId: string, role: EduRole): Promise<EduLab[]>;
  linkGithub(input: LinkEduGithubInput): Promise<EduAccount>;
}
