import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { GithubInstallationsRepository } from './github-installations.repository';
import { GithubController } from './github.controller';
import { GithubTeamRoleReconcileWorker } from './github-team-role-reconcile.worker';
import { GithubTeamRoleService } from './github-team-role.service';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubService } from './github.service';

@Module({
  imports: [DatabaseModule, EventsModule, AuditModule],
  controllers: [GithubController, GithubWebhookController],
  providers: [
    GithubService,
    GithubTeamRoleService,
    GithubTeamRoleReconcileWorker,
    GithubInstallationsRepository,
    SessionAuthGuard,
  ],
  exports: [GithubService, GithubTeamRoleService],
})
export class GithubModule {}
