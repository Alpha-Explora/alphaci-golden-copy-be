import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '#kernel/db/database.module';
import { WORKSPACE_RUNTIME_DATA_CLEANUP } from '#kernel/ports/workspace-data-cleanup.port';
import { WorkspacesModule } from '#modules/identity-access/workspaces/workspaces.module';
import { OnpremMachinesRepository } from './infrastructure/repositories/onprem-machines.repository';
import { OnpremHostsService } from './application/onprem/onprem-hosts.service';
import { OnpremHostsController } from './api/onprem-hosts.controller';
import { OnpremEnrollmentController } from './api/onprem-enrollment.controller';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module';

@Global()
@Module({
  imports: [DatabaseModule, WorkspacesModule, SubscriptionModule],
  providers: [
    OnpremMachinesRepository,
    OnpremHostsService,
    SessionAuthGuard,
    SubscriptionGuard,
    {
      provide: WORKSPACE_RUNTIME_DATA_CLEANUP,
      useExisting: OnpremMachinesRepository,
    },
  ],
  controllers: [OnpremHostsController, OnpremEnrollmentController],
  exports: [
    OnpremMachinesRepository,
    OnpremHostsService,
    WORKSPACE_RUNTIME_DATA_CLEANUP,
  ],
})
export class OnpremHostsModule {}
