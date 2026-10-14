import { Module } from '@nestjs/common';

import { SupabaseModule } from '#kernel/db/supabase/supabase.module.js';
import { QA_ATTACHMENT_STORAGE } from './application/qa-runs/qa-attachment-storage.port';
import { QaAttachmentStorage } from './infrastructure/qa-attachment-storage';

/**
 * Binds QA_ATTACHMENT_STORAGE to the private `qa-attachments` Supabase Storage
 * bucket (service role key). A module of its own, rather than a provider of
 * QaRunsModule, because application code may not import infrastructure classes
 * (scripts/check-application-boundaries.cjs): the application depends on the
 * port, and this composition file is where the implementation is chosen.
 */
@Module({
  imports: [SupabaseModule],
  providers: [
    { provide: QA_ATTACHMENT_STORAGE, useClass: QaAttachmentStorage },
  ],
  exports: [QA_ATTACHMENT_STORAGE],
})
export class QaAttachmentStorageModule {}
