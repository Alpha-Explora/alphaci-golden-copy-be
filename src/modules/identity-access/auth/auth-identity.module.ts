import { Global, Module } from '@nestjs/common';

import { SESSION_USER_LOOKUP } from '#kernel/auth/session-user-lookup.contract';
import { DatabaseModule } from '#kernel/db/database.module';
import { OAuthStateRepository } from './infrastructure/oauth-state.repository';
import { AuthSessionHandoffRepository } from './infrastructure/auth-session-handoff.repository';
import { EmailVerificationCodesRepository } from './infrastructure/email-verification-codes.repository';
import { UserIdentitiesRepository } from './infrastructure/user-identities.repository';
import { UsersRepository } from './infrastructure/users.repository';

/**
 * Auth-owned identity persistence and the narrow session lookup contract used
 * by the shared HTTP guard.  It is global because guards are intentionally
 * registered by many feature modules; the exported surface is still only the
 * identity contract and repository needed by Auth's own application service.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    UsersRepository,
    OAuthStateRepository,
    UserIdentitiesRepository,
    EmailVerificationCodesRepository,
    AuthSessionHandoffRepository,
    {
      provide: SESSION_USER_LOOKUP,
      useExisting: UsersRepository,
    },
  ],
  exports: [
    UsersRepository,
    OAuthStateRepository,
    UserIdentitiesRepository,
    EmailVerificationCodesRepository,
    AuthSessionHandoffRepository,
    SESSION_USER_LOOKUP,
  ],
})
export class AuthIdentityModule {}
