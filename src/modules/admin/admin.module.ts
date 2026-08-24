import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../../kernel/db/database.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { AdminController } from './admin.controller';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import { PlatformAdminsRepository } from './platform-admins.repository';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';

@Module({
  imports: [DatabaseModule, PersistenceModule, AuditModule, FeedbackModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminRepository,
    PlatformAdminsRepository,
    PlatformAdminGuard,
    SuperAdminGuard,
    SessionAuthGuard,
  ],
  // Exported so AuthModule can resolve the caller's platform role for /auth/me.
  exports: [PlatformAdminsRepository],
})
export class AdminModule {}
