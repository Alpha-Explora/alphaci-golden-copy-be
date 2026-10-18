import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import { DatabaseModule } from '#kernel/db/database.module.js';
import { SupabaseModule } from '#kernel/db/supabase/supabase.module.js';
import {
  QA_ATTACHMENT_STORAGE,
  type QaAttachmentStoragePort,
} from './application/qa-runs/qa-attachment-storage.port';
import { PostgresQaAttachmentStorage } from './infrastructure/qa-attachment-storage.postgres';
import { PostgresQaAttachmentOrphanSweep } from './infrastructure/qa-attachment-orphan-sweep.postgres';
import { QaAttachmentOrphanSweepWorker } from './infrastructure/qa-attachment-orphan-sweep.worker';
import { QaAttachmentStorage } from './infrastructure/qa-attachment-storage';

/**
 * Binds QA_ATTACHMENT_STORAGE to the driver chosen by STORAGE_DRIVER
 * (see kernel/config/deployment-mode.ts):
 *
 *   supabase  the private `qa-attachments` Storage bucket (service role key)
 *   postgres  bytea rows in projects.qa_attachment_objects, served by the backend
 *
 * It also schedules the orphaned-bytes sweep, which only the postgres driver needs.
 *
 * A module of its own, rather than a provider of QaRunsModule, because
 * application code may not import infrastructure classes
 * (scripts/check-application-boundaries.cjs): the application depends on the
 * port, and this composition file is where the implementation is chosen.
 */
@Module({
  imports: [DatabaseModule, SupabaseModule],
  providers: [
    QaAttachmentStorage,
    PostgresQaAttachmentStorage,
    PostgresQaAttachmentOrphanSweep,
    // Runs only when STORAGE_DRIVER=postgres (see the worker).
    QaAttachmentOrphanSweepWorker,
    {
      provide: QA_ATTACHMENT_STORAGE,
      inject: [ConfigService, QaAttachmentStorage, PostgresQaAttachmentStorage],
      useFactory: (
        config: ConfigService,
        supabase: QaAttachmentStorage,
        postgres: PostgresQaAttachmentStorage,
      ): QaAttachmentStoragePort =>
        config.getOrThrow<AppConfig>('app').storage.driver === 'supabase'
          ? supabase
          : postgres,
    },
  ],
  exports: [QA_ATTACHMENT_STORAGE],
})
export class QaAttachmentStorageModule {}
