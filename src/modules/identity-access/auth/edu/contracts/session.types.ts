import 'express-session';

import type { EduRole } from '../model/edu-auth.types.js';

declare module 'express-session' {
  interface SessionData {
    /** EDU identity is separate from the shared SaaS/Enterprise session fields. */
    eduUserId?: string;
    eduRole?: EduRole;
    eduSelectedLabId?: string;
    eduGithubOAuthState?: string;
    eduGithubOAuthReturnTo?: string;
    eduGithubOAuthUserId?: string;
  }
}
