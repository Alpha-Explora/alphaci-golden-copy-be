import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../kernel/db/database.service';
import type {
  CreateFeedbackInput,
  FeedbackCategory,
  FeedbackRecord,
  FeedbackStatus,
  UpdateFeedbackInput,
} from './feedback.types';
export type {
  CreateFeedbackInput,
  FeedbackCategory,
  FeedbackRecord,
  FeedbackStatus,
  UpdateFeedbackInput,
} from './feedback.types';

interface FeedbackRow {
  id: string;
  user_id: string;
  user_login: string | null;
  category: FeedbackCategory;
  subject: string;
  body: string;
  status: FeedbackStatus;
  admin_response: string | null;
  responded_by: string | null;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class FeedbackRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: CreateFeedbackInput): Promise<FeedbackRecord> {
    const result = await this.databaseService.query<FeedbackRow>(
      `
        WITH inserted AS (
          INSERT INTO support.feedback (user_id, category, subject, body)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        )
        SELECT inserted.*, u.login AS user_login
        FROM inserted
        LEFT JOIN identity.app_users AS u ON u.id = inserted.user_id;
      `,
      [input.userId, input.category, input.subject, input.body],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Feedback insert did not return a row');
    }
    return this.toRecord(row);
  }

  async listByUser(userId: string): Promise<FeedbackRecord[]> {
    const result = await this.databaseService.query<FeedbackRow>(
      `
        SELECT f.*, u.login AS user_login
        FROM support.feedback AS f
        LEFT JOIN identity.app_users AS u ON u.id = f.user_id
        WHERE f.user_id = $1
        ORDER BY f.created_at DESC;
      `,
      [userId],
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  async listAll(status?: FeedbackStatus): Promise<FeedbackRecord[]> {
    const clause = status ? 'WHERE f.status = $1' : '';
    const params = status ? [status] : [];
    const result = await this.databaseService.query<FeedbackRow>(
      `
        SELECT f.*, u.login AS user_login
        FROM support.feedback AS f
        LEFT JOIN identity.app_users AS u ON u.id = f.user_id
        ${clause}
        ORDER BY f.created_at DESC
        LIMIT 200;
      `,
      params,
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  async update(
    id: string,
    input: UpdateFeedbackInput,
  ): Promise<FeedbackRecord | null> {
    const result = await this.databaseService.query<FeedbackRow>(
      `
        WITH updated AS (
          UPDATE support.feedback
          SET
            status         = COALESCE($2, status),
            admin_response = COALESCE($3, admin_response),
            responded_by   = CASE WHEN $3 IS NOT NULL THEN $4 ELSE responded_by END,
            responded_at   = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE responded_at END,
            updated_at     = NOW()
          WHERE id = $1
          RETURNING *
        )
        SELECT updated.*, u.login AS user_login
        FROM updated
        LEFT JOIN identity.app_users AS u ON u.id = updated.user_id;
      `,
      [
        id,
        input.status ?? null,
        input.adminResponse ?? null,
        input.respondedBy,
      ],
    );
    const row = result.rows[0];
    return row ? this.toRecord(row) : null;
  }

  private toRecord(row: FeedbackRow): FeedbackRecord {
    return {
      id: row.id,
      userId: row.user_id,
      userLogin: row.user_login,
      category: row.category,
      subject: row.subject,
      body: row.body,
      status: row.status,
      adminResponse: row.admin_response,
      respondedBy: row.responded_by,
      respondedAt: row.responded_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
