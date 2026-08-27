export type FeedbackCategory =
  'general' | 'bug' | 'feature_request' | 'billing' | 'other';

export type FeedbackStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';

export interface FeedbackRecord {
  id: string;
  userId: string;
  userLogin: string | null;
  category: FeedbackCategory;
  subject: string;
  body: string;
  status: FeedbackStatus;
  adminResponse: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateFeedbackInput {
  status?: FeedbackStatus;
  adminResponse?: string;
  respondedBy: string;
}

/** Admin-facing feedback capability exposed without leaking the service class. */
export interface FeedbackPort {
  listAll(status?: FeedbackStatus): Promise<FeedbackRecord[]>;
  triage(id: string, input: UpdateFeedbackInput): Promise<FeedbackRecord>;
}

export const FEEDBACK_PORT = Symbol('FEEDBACK_PORT');
