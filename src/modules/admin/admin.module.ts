import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../../kernel/db/database.module';
import { FeedbackModule } from '../feedback/feedback.module.js';
import { AdminController } from './admin.controller';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import { PlatformAdminsRepository } from './platform-admins.repository';
import { PlatformAdminAccessService } from './platform-admin-access.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';

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
