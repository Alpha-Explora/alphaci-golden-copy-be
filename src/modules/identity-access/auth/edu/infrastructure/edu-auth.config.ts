import type { EduAuthConfig } from '../application/edu-auth.ports.js';

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readEnv(name).toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

function readDomains(): string[] {
  return readEnv('EDU_STUDENT_EMAIL_DOMAINS')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter((domain) => domain.length > 0);
}

function frontendUrl(): string {
  return (
    readEnv('EDU_FRONTEND_URL') ||
    readEnv('FRONTEND_URL') ||
    'http://localhost:3000'
  );
}

function backendOrigin(): string {
  return (readEnv('PLATFORM_PUBLIC_URL') || 'http://localhost:4000')
    .replace(/\/+$/u, '')
    .replace(/\/api\/v1$/u, '');
}

/**
 * EDU configuration is deliberately local to the EDU composition root. The
 * orchestrator can later project these values into AppConfig without making
 * the shared SaaS/Enterprise auth services depend on EDU variables.
 */
export function createEduAuthConfig(): EduAuthConfig {
  const frontend = frontendUrl();

  return {
    enabled: readBoolean(
      'AUTH_EDU_ENABLED',
      readBoolean('EDU_AUTH_ENABLED', process.env['ALPHACI_EDITION'] === 'edu'),
    ),
    frontendUrl: frontend,
    sessionCookieName: readEnv('SESSION_COOKIE_NAME') || 'cicd_workflow_sid',
    studentEmailDomains: readDomains(),
    studentJitProvisioningEnabled: readBoolean(
      'EDU_STUDENT_JIT_PROVISIONING',
      false,
    ),
    supabaseUrl: readEnv('EDU_SUPABASE_URL'),
    supabaseAnonKey: readEnv('EDU_SUPABASE_ANON_KEY'),
    supabasePasswordResetRedirectUrl:
      readEnv('EDU_SUPABASE_PASSWORD_RESET_REDIRECT') ||
      `${frontend}/auth/reset-password`,
    supabaseSignupRedirectUrl:
      readEnv('EDU_SUPABASE_SIGNUP_REDIRECT') || `${frontend}/signin`,
    githubClientId: readEnv('EDU_GITHUB_CLIENT_ID'),
    githubClientSecret: readEnv('EDU_GITHUB_CLIENT_SECRET'),
    githubCallbackUrl:
      readEnv('EDU_GITHUB_CALLBACK_URL') ||
      `${backendOrigin()}/api/v1/auth/edu/github/callback`,
    githubScope: readEnv('EDU_GITHUB_SCOPE') || 'read:user user:email',
  };
}
