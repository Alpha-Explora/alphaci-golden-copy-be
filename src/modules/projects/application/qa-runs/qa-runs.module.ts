import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { GithubModule } from '#modules/pipelines/github/github.module.js';
import { RuntimeModule } from '#modules/runtime/runtime.module.js';
import {
  ProjectQaReturnedItemsController,
  ProjectQaRunsController,
} from '../../api/qa-runs.controller';
import { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import { QaChecklistsModule } from '../qa-checklists/qa-checklists.module';
import { QaCommitResolutionService } from './qa-commit-resolution.service';
import { QaRunsService } from './qa-runs.service';

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    // Both imported directly (not received through ProjectsModule) because
    // Nest DI only resolves from a module's OWN providers or from a module
    // it imports itself — not "sideways" from a sibling module that
    // ProjectsModule also happens to import. GithubModule exports
    // GITHUB_PROJECT_PORT and RuntimeModule exports DEPLOYMENT_HISTORY_QUERY,
    // both of which QaCommitResolutionService needs.
    GithubModule,
    RuntimeModule,
    // Supplies QaAccessService (project visibility, app-role, workspace-lead
    // lookups) and QaChecklistsRepository (checklist + item snapshot source
    // for POST create) — both exported by this module already.
    QaChecklistsModule,
  ],
  controllers: [ProjectQaRunsController, ProjectQaReturnedItemsController],
  providers: [
    SessionAuthGuard,
    QaRunsRepository,
    QaCommitResolutionService,
    QaRunsService,
  ],
  exports: [QaRunsService],
})
export class QaRunsModule {}
