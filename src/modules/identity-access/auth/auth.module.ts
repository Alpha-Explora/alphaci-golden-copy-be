import { Module } from '@nestjs/common';

import { DevOnlyGuard } from '#kernel/auth/dev-only.guard';
import { DevQuickLoginGuard } from '#kernel/auth/dev-quick-login.guard';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { EventsModule } from '#kernel/events/events.module';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { AdminModule } from '#modules/identity-access/admin/admin.module.js';
import { GithubModule } from '#modules/pipelines/github/github.module';
import { AuthController } from './api/auth.controller';
import { AuthService } from './application/auth.service';
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
  providers: [AuthService, DevOnlyGuard, DevQuickLoginGuard, SessionAuthGuard],
  exports: [AuthService],
})
export class AuthModule {}
