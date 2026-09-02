import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { FeedbackController } from './api/feedback.controller';
import { FeedbackRepository } from './infrastructure/feedback.repository';
import { FeedbackService } from './application/feedback.service';
import { FEEDBACK_PORT } from '#kernel/ports/feedback.port';

@Module({
  imports: [DatabaseModule],
  controllers: [FeedbackController],
  providers: [
    FeedbackRepository,
    FeedbackService,
    { provide: FEEDBACK_PORT, useExisting: FeedbackService },
    SessionAuthGuard,
  ],
  exports: [FeedbackService, FEEDBACK_PORT],
})
export class FeedbackModule {}
