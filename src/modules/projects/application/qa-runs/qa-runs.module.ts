import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { CiModule } from '#modules/pipelines/ci/ci.module.js';
import { GithubModule } from '#modules/pipelines/github/github.module.js';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { RuntimeModule } from '#modules/runtime/runtime.module.js';
import { DeliveryProjectQaAttachmentsController } from '../../api/qa-run-attachments.controller';
import {
  DeliveryProjectQaMyItemsController,
  DeliveryProjectQaRunsController,
} from '../../api/qa-project-runs.controller';
import {
  DeliveryProjectRequirementsController,
  RequirementsController,
  WorkspaceQaRequirementsController,
} from '../../api/qa-requirements.controller';
import {
  ProjectQaMyItemsController,
  ProjectQaPromotionController,
  ProjectQaReturnedItemsController,
  ProjectQaRunsController,
} from '../../api/qa-runs.controller';
import { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import { QaRunAttachmentsRepository } from '../../infrastructure/qa-run-attachments.repository';
import { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import { QaAttachmentStorageModule } from '../../qa-attachment-storage.module';
import { QaChecklistsModule } from '../qa-checklists/qa-checklists.module';
import { QaRequirementsService } from '../qa-checklists/qa-requirements.service';
import { QaAutomationDispatchService } from './qa-automation-dispatch.service';
import { QaAutomationService } from './qa-automation.service';
import { QaCommitResolutionService } from './qa-commit-resolution.service';
import { QaProjectRunsService } from './qa-project-runs.service';
import { QaRunAttachmentsService } from './qa-run-attachments.service';
import { QaPromotionService } from './qa-promotion.service';
import { QaReportService } from './qa-report.service';
import { QaRunsService } from './qa-runs.service';
import { QaUatHeadsService } from './qa-uat-heads.service';

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    // QA_ATTACHMENT_STORAGE: the private qa-attachments bucket (service role key).
    QaAttachmentStorageModule,
    // All imported directly (not received through ProjectsModule) because
    // Nest DI only resolves from a module's OWN providers or from a module
    // it imports itself — not "sideways" from a sibling module that
    // ProjectsModule also happens to import. GithubModule exports
    // GITHUB_PROJECT_PORT (QaCommitResolutionService, QaAutomationDispatchService),
    // RuntimeModule exports DEPLOYMENT_HISTORY_QUERY
    // (QaCommitResolutionService), and CiModule exports
    // CI_STAGE_RESULTS_LOOKUP (QaAutomationService).
    GithubModule,
    RuntimeModule,
    CiModule,
    // AUDIT_LATEST_EVENT_QUERY_PORT (QaRequirementsService.overview: promotion merges).
    AuditModule,
    // Supplies QaAccessService (project visibility, app-role, workspace-lead
    // lookups) and QaChecklistsRepository (checklist + item snapshot source
    // for POST create) — both exported by this module already.
    QaChecklistsModule,
  ],
  controllers: [
    ProjectQaRunsController,
    ProjectQaReturnedItemsController,
    ProjectQaMyItemsController,
    ProjectQaPromotionController,
    DeliveryProjectQaRunsController,
    DeliveryProjectQaMyItemsController,
    DeliveryProjectQaAttachmentsController,
    DeliveryProjectRequirementsController,
    RequirementsController,
    WorkspaceQaRequirementsController,
  ],
  providers: [
    SessionAuthGuard,
    QaRunsRepository,
    QaProjectRunsRepository,
    QaRunAttachmentsRepository,
    QaUatHeadsService,
    QaRequirementsService,
    QaProjectRunsService,
    QaRunAttachmentsService,
    QaCommitResolutionService,
    QaAutomationService,
    QaAutomationDispatchService,
    QaRunsService,
    QaReportService,
    QaPromotionService,
  ],
  exports: [
    QaRunsService,
    QaReportService,
    QaPromotionService,
    // Implements DELIVERY_PROJECT_DATA_CLEANUP (bound in ProjectProvisioningModule).
    QaRequirementsService,
    QaProjectRunsService,
  ],
})
export class QaRunsModule {}
