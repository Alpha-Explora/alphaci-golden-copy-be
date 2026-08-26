import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { AuditEventsRepository } from './audit-events.repository';
import { AuditEventsService } from './audit-events.service';

@Module({
  imports: [DatabaseModule],
  providers: [AuditEventsRepository, AuditEventsService],
  exports: [AuditEventsService],
})
export class AuditModule {}
