import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../../kernel/db/database.service';

interface OutboxEventInput {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

@Injectable()
export class OutboxRepository {
  private readonly logger = new Logger(OutboxRepository.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async publishLater(event: OutboxEventInput): Promise<void> {
    try {
      await this.databaseService.query(
        `
          INSERT INTO outbox_events (
            topic,
            aggregate_type,
            aggregate_id,
            payload,
            status
          )
          VALUES ($1, $2, $3, $4::jsonb, 'pending');
        `,
        [
          event.topic,
          event.aggregateType,
          event.aggregateId,
          JSON.stringify(event.payload ?? {}),
        ],
      );
    } catch (error) {
      this.logger.warn(`Outbox write skipped: ${(error as Error).message}`);
    }
  }
}
