import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../kernel/db/database.module';
import { AuditEventsRepository } from './audit-events.repository';
import { AuditEventsService } from './audit-events.service';

@Module({
  imports: [DatabaseModule],
  providers: [AuditEventsRepository, AuditEventsService],
  // AuditEventsRepository is exported for always-on audit writes (e.g. the admin
  // module) that must bypass the feature-flag gating in AuditEventsService.
  exports: [AuditEventsService, AuditEventsRepository],
})
export class AuditModule {}
