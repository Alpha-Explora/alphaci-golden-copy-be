import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { FeedbackModule } from '#modules/platform-ops/feedback/feedback.module.js';
import { AdminController } from './api/admin.controller';
import { AdminRepository } from './infrastructure/admin.repository';
import { AdminService } from './application/admin.service';
import { PlatformAdminsRepository } from './infrastructure/platform-admins.repository';
import { PlatformAdminAccessService } from './application/platform-admin-access.service';
import { PlatformAdminGuard } from './api/guards/platform-admin.guard';
import { SuperAdminGuard } from './api/guards/super-admin.guard';

@Module({
  imports: [DatabaseModule, AuditModule, FeedbackModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminRepository,
    PlatformAdminsRepository,
    PlatformAdminAccessService,
    PlatformAdminGuard,
    SuperAdminGuard,
    SessionAuthGuard,
  ],
  // Exported as a policy service; the repository remains Admin infrastructure.
  exports: [PlatformAdminAccessService],
})
export class AdminModule {}
