import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { DatabaseModule } from '../../kernel/db/database.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackRepository } from './feedback.repository';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [DatabaseModule, PersistenceModule],
  controllers: [FeedbackController],
  providers: [FeedbackRepository, FeedbackService, SessionAuthGuard],
  exports: [FeedbackService],
})
export class FeedbackModule {}
