export {
  type FeedbackCategory,
  type FeedbackRecord,
  type FeedbackStatus,
  type UpdateFeedbackInput,
} from '#kernel/ports/feedback.port';

import type { FeedbackCategory } from '#kernel/ports/feedback.port';

export interface CreateFeedbackInput {
  userId: string;
  category: FeedbackCategory;
  subject: string;
  body: string;
}
