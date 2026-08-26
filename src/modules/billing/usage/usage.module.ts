import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { UsageController } from './usage.controller';
import { UsageQuotaService } from './usage-quota.service';

@Module({
  imports: [DatabaseModule],
  controllers: [UsageController],
  providers: [UsageQuotaService, SessionAuthGuard],
  exports: [UsageQuotaService],
})
export class UsageModule {}
