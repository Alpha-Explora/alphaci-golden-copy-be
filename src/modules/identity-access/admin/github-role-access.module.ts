import { Global, Module } from '@nestjs/common';

import { PLATFORM_ADMIN_PORT } from '#kernel/ports/platform-admin.port';
import { AdminModule } from './admin.module';
import { PlatformAdminAccessService } from './platform-admin-access.service';

/** Composition-only bridge from the identity role policy to GitHub pipelines. */
@Global()
@Module({
  imports: [AdminModule],
  providers: [
    {
      provide: PLATFORM_ADMIN_PORT,
      useExisting: PlatformAdminAccessService,
    },
  ],
  exports: [PLATFORM_ADMIN_PORT],
})
export class GithubRoleAccessModule {}
