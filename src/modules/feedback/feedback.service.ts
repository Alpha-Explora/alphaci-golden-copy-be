import { Injectable, NotFoundException } from '@nestjs/common';

import { FeedbackRepository } from './feedback.repository';
import type {
  FeedbackRecord,
  FeedbackStatus,
  UpdateFeedbackInput,
} from './feedback.types';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto';

@Injectable()
export class FeedbackService {
  constructor(private readonly repository: FeedbackRepository) {}

  async submit(
    userId: string,
    dto: SubmitFeedbackDto,
  ): Promise<FeedbackRecord> {
    return this.repository.create({
      userId,
      category: dto.category ?? 'general',
      subject: dto.subject,
      body: dto.body,
    });
  }

  async listForUser(userId: string): Promise<FeedbackRecord[]> {
    return this.repository.listByUser(userId);
  }

  /** Admin-side: list all feedback, optionally filtered by status. */
  async listAll(status?: FeedbackStatus): Promise<FeedbackRecord[]> {
    return this.repository.listAll(status);
  }

  /** Admin-side: triage update (status and/or response). */
  async triage(
    id: string,
    input: UpdateFeedbackInput,
  ): Promise<FeedbackRecord> {
    const updated = await this.repository.update(id, input);
    if (!updated) {
      throw new NotFoundException('Feedback not found');
    }
    return updated;
  }
}
