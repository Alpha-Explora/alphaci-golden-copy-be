import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module.js';
import {
  EDU_AUTH_CONFIG,
  EDU_AUTH_REPOSITORY,
  EDU_GITHUB_OAUTH_PORT,
  SUPABASE_AUTH_PORT,
} from './application/edu-auth.ports.js';
import { EduAuthService } from './application/edu-auth.service.js';
import { EduAuthController } from './api/edu-auth.controller.js';
import { EduAuthEnabledGuard } from './api/guards/edu-auth-enabled.guard.js';
import { EduSessionGuard } from './api/guards/edu-session.guard.js';
import { createEduAuthConfig } from './infrastructure/edu-auth.config.js';
import { EduGithubOAuthAdapter } from './infrastructure/edu-github-oauth.adapter.js';
import { EduAuthRepository } from './infrastructure/edu-auth.repository.js';
import { EduSupabaseAuthAdapter } from './infrastructure/edu-supabase-auth.adapter.js';

/**
 * EDU-only composition root. It intentionally does not import AuthModule or
 * IdentityAccessModule. The profile orchestrator owns the single import seam so
 * hosted-saas can physically omit this directory.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [EduAuthController],
  providers: [
    {
      provide: EDU_AUTH_CONFIG,
      useFactory: createEduAuthConfig,
    },
    EduAuthRepository,
    {
      provide: EDU_AUTH_REPOSITORY,
      useExisting: EduAuthRepository,
    },
    {
      provide: SUPABASE_AUTH_PORT,
      useClass: EduSupabaseAuthAdapter,
    },
    {
      provide: EDU_GITHUB_OAUTH_PORT,
      useClass: EduGithubOAuthAdapter,
    },
    EduAuthService,
    EduAuthEnabledGuard,
    EduSessionGuard,
  ],
  exports: [EduAuthService, EDU_AUTH_CONFIG],
})
export class EduAuthModule {}
