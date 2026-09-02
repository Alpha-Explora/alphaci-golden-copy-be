import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import {
  GITHUB_ORGANIZATION_PORT,
  GITHUB_PROJECT_PORT,
} from '#kernel/ports/github.port';
import { GITHUB_TEAM_ROLE_PORT } from '#kernel/ports/github-team-role.port';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { GithubInstallationsRepository } from './infrastructure/github-installations.repository';
import { GithubController } from './api/github.controller';
import { GithubTeamRoleReconcileWorker } from './application/github-team-role-reconcile.worker';
import { GithubTeamRoleService } from './application/github-team-role.service';
import { GithubWebhookController } from './api/github-webhook.controller';
import { GithubService } from './infrastructure/github.service';

@Module({
  imports: [DatabaseModule, EventsModule, AuditModule],
  controllers: [GithubController, GithubWebhookController],
  providers: [
    GithubService,
    GithubTeamRoleService,
    { provide: GITHUB_PROJECT_PORT, useExisting: GithubService },
    { provide: GITHUB_ORGANIZATION_PORT, useExisting: GithubService },
    { provide: GITHUB_TEAM_ROLE_PORT, useExisting: GithubTeamRoleService },
    GithubTeamRoleReconcileWorker,
    GithubInstallationsRepository,
    SessionAuthGuard,
  ],
  exports: [
    GithubService,
    GithubTeamRoleService,
    GITHUB_PROJECT_PORT,
    GITHUB_ORGANIZATION_PORT,
    GITHUB_TEAM_ROLE_PORT,
  ],
})
export class GithubModule {}
