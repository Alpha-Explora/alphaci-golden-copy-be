import 'express-session';

import type { SessionUser } from '#kernel/auth/session-user.interface';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** Selector only; SessionAuthGuard revalidates membership on every request. */
    tenantId?: string;
    user?: SessionUser;
    oauthState?: string;
    oauthReturnTo?: string;
    oauthProvider?: 'github' | 'google';
    githubAccessToken?: string;
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
