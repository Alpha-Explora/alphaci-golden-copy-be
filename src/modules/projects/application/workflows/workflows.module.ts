import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { CatalogModule } from '../catalog/catalog.module';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { WorkflowsController } from '../../api/workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowHistoryRepository } from './infrastructure/workflow-history.repository';
import { WORKFLOW_HISTORY_QUERY } from './workflows.contracts';

@Module({
  imports: [CatalogModule, SubscriptionModule, DatabaseModule, EventsModule],
  controllers: [WorkflowsController],
  providers: [
    WorkflowHistoryRepository,
    {
      provide: WORKFLOW_HISTORY_QUERY,
      useExisting: WorkflowHistoryRepository,
    },
    WorkflowsService,
    SessionAuthGuard,
    SubscriptionGuard,
  ],
  exports: [WorkflowsService, WORKFLOW_HISTORY_QUERY],
})
export class WorkflowsModule {}
