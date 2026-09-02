import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import {
  AUDIT_QUERY_PORT,
  AUDIT_SECURITY_PORT,
} from '#kernel/ports/audit.port';
import { AuditEventsRepository } from './infrastructure/audit-events.repository';
import { AuditEventsService } from './application/audit-events.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    AuditEventsRepository,
    AuditEventsService,
    { provide: AUDIT_QUERY_PORT, useExisting: AuditEventsService },
    { provide: AUDIT_SECURITY_PORT, useExisting: AuditEventsService },
  ],
  exports: [AuditEventsService, AUDIT_QUERY_PORT, AUDIT_SECURITY_PORT],
})
export class AuditModule {}
