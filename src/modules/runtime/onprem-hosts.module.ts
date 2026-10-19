import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '#kernel/db/database.module';
import { WORKSPACE_RUNTIME_DATA_CLEANUP } from '#kernel/ports/workspace-data-cleanup.port';
import { WorkspacesModule } from '#modules/identity-access/workspaces/workspaces.module';
import { OnpremMachinesRepository } from './infrastructure/repositories/onprem-machines.repository';
import { OnpremInstallerReleaseClient } from './infrastructure/providers/onprem/onprem-installer-release.client';
import { ONPREM_INSTALLER_RELEASE } from './application/ports/onprem-installer-release.port';
import { RELEASE_SIGNER } from './application/ports/release-signer.port';
import { createReleaseSigner } from './infrastructure/release-signing/release-signer';
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
    OnpremInstallerReleaseClient,
    {
      provide: ONPREM_INSTALLER_RELEASE,
      useExisting: OnpremInstallerReleaseClient,
    },
    {
      // Read once at boot. Runner mode yields a signer that never signs.
      provide: RELEASE_SIGNER,
      useFactory: (config: ConfigService) =>
        createReleaseSigner((key) => config.get<string>(key)),
      inject: [ConfigService],
    },
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
    RELEASE_SIGNER,
    WORKSPACE_RUNTIME_DATA_CLEANUP,
  ],
})
export class OnpremHostsModule {}
