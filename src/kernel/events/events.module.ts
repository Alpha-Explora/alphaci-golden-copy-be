import { Module } from '@nestjs/common';

import { DatabaseModule } from '../db/database.module';
import { OutboxRepository } from './outbox.repository';

/** Technical outbox adapter shared by modules that publish integration work. */
@Module({
  imports: [DatabaseModule],
  providers: [OutboxRepository],
  exports: [OutboxRepository],
})
export class EventsModule {}
