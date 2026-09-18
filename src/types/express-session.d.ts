import 'express-session';

import type { SessionUser } from '#kernel/auth/session-user.interface';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    tenantId?: string;
    user?: SessionUser;
    oauthState?: string;
    oauthReturnTo?: string;
    oauthProvider?: 'github' | 'google';
    githubAccessToken?: string;
    /** EDU profile/session state is only composed into the hosted-EDU artifact. */
    eduUserId?: string;
    eduRole?: 'STUDENT' | 'TEACHER' | 'ADMIN' | 'SUPER_ADMIN';
    eduSelectedLabId?: string;
    eduGithubOAuthState?: string;
    eduGithubOAuthReturnTo?: string;
    eduGithubOAuthUserId?: string;
    pendingArchived?: {
      githubUserId: string;
      login: string;
      name?: string;
      email?: string;
      avatarUrl?: string;
      accessToken: string;
      // boolean when membership was verifiable (internal deployment); null on
      // the sold deployment, meaning "preserve the existing is_internal flag".
      isInternal: boolean | null;
    };
  }
}
