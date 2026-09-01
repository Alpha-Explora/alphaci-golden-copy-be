import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import {
  MANAGED_QUOTA_REGISTRAR,
  USAGE_QUOTA,
} from '#kernel/ports/usage-quota.port';
import { UsageController } from './usage.controller';
import { UsageQuotaService } from './usage-quota.service';

@Module({
  imports: [DatabaseModule],
  controllers: [UsageController],
  providers: [
    UsageQuotaService,
    { provide: USAGE_QUOTA, useExisting: UsageQuotaService },
    { provide: MANAGED_QUOTA_REGISTRAR, useExisting: UsageQuotaService },
    SessionAuthGuard,
  ],
  exports: [UsageQuotaService, USAGE_QUOTA, MANAGED_QUOTA_REGISTRAR],
})
export class UsageModule {}
