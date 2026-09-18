import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DevOnlyGuard } from '#kernel/auth/dev-only.guard';
import { DevQuickLoginGuard } from '#kernel/auth/dev-quick-login.guard';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type { AppConfig } from '#kernel/config/app.config';
import { EventsModule } from '#kernel/events/events.module';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { AdminModule } from '#modules/identity-access/admin/admin.module.js';
import { GithubModule } from '#modules/pipelines/github/github.module';
import { AuthController } from './api/auth.controller';
import { AuthService } from './application/auth.service';
import {
  ADMISSION_POLICY,
  type AdmissionPolicy,
} from './application/admission/admission-policy.port';
import { OpenRegistrationAdmissionPolicy } from './application/admission/open-registration.policy';
import { OrgMembershipAdmissionPolicy } from './application/admission/org-membership.policy';
import { AuthIdentityModule } from './auth-identity.module';

@Module({
  imports: [
    SubscriptionModule,
    AuthIdentityModule,
    EventsModule,
    AdminModule,
    // GithubTeamRoleService — derives app_role from GitHub org teams at login.
    GithubModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: ADMISSION_POLICY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): AdmissionPolicy => {
        const config = configService.getOrThrow<AppConfig>('app');

        // Explicit AUTH_ADMISSION controls only the gate. An internal org
        // still selects this implementation in open mode because membership
        // remains the independent source of isInternal stamping.
        if (
          config.github.internalOrg ||
          config.auth.admission === 'org-membership'
        ) {
          return new OrgMembershipAdmissionPolicy({
            internalOrg: config.github.internalOrg,
            admission: config.auth.admission,
          });
        }

        return new OpenRegistrationAdmissionPolicy();
      },
    },
    DevOnlyGuard,
    DevQuickLoginGuard,
    SessionAuthGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
