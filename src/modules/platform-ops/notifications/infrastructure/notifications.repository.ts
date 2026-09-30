import { Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '#kernel/db/database.service';
import type {
  CreateNotificationInput,
  NotificationItem,
  NotificationPreferences,
  NotificationsResponse,
} from '../notifications.types';

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  event_code: string;
  read_at: string | Date | null;
  created_at: string | Date;
  project_id: string | null;
  delivery_project_id: string | null;
  group_id: string | null;
}

interface NotificationPreferencesRow {
  user_id: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  updated_at: string | Date;
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async listForUser(userId: string): Promise<NotificationsResponse> {
    const result = await this.databaseService.query<NotificationRow>(
      `
        SELECT
          n.id,
          n.title,
          n.body,
          n.event_code,
          n.read_at,
          n.created_at,
          n.project_id,
          hr.delivery_project_id,
          hr.group_id
        FROM notifications.notifications n
        LEFT JOIN hierarchy.repositories hr
          ON hr.provisioned_project_id = n.project_id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 50;
      `,
      [userId],
    );

    const items = result.rows.map((row) => this.toItem(row));
    return {
      enabled: true,
      items,
      unreadCount: items.filter((item) => item.readAt === null).length,
    };
  }

  async markRead(
    userId: string,
    id: string,
  ): Promise<{ id: string; read: true }> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        UPDATE notifications.notifications
        SET read_at = COALESCE(read_at, NOW())
        WHERE id = $1
          AND user_id = $2
        RETURNING id;
      `,
      [id, userId],
    );

    if (!result.rows[0]) {
      throw new NotFoundException('Notification not found');
    }

    return { id: result.rows[0].id, read: true };
  }

  async createForUser(
    input: CreateNotificationInput,
  ): Promise<NotificationItem> {
    const result = await this.databaseService.query<NotificationRow>(
      `
        WITH inserted AS (
          INSERT INTO notifications.notifications (
            user_id,
            project_id,
            event_code,
            title,
            body
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, title, body, event_code, read_at, created_at, project_id
        )
        SELECT
          i.id,
          i.title,
          i.body,
          i.event_code,
          i.read_at,
          i.created_at,
          i.project_id,
          hr.delivery_project_id,
          hr.group_id
        FROM inserted i
        LEFT JOIN hierarchy.repositories hr
          ON hr.provisioned_project_id = i.project_id;
      `,
      [
        input.userId,
        input.projectId ?? null,
        input.eventCode,
        input.title,
        input.body,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Notification insert did not return a row');
    }
    return this.toItem(row);
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    await this.databaseService.query(
      `
        INSERT INTO notifications.notification_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING;
      `,
      [userId],
    );

    const result = await this.databaseService.query<NotificationPreferencesRow>(
      `
        SELECT user_id, in_app_enabled, email_enabled, updated_at
        FROM notifications.notification_preferences
        WHERE user_id = $1;
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Notification preferences query did not return a row');
    }
    return this.toPreferences(row);
  }

  async updatePreferences(
    userId: string,
    input: { inAppEnabled?: boolean; emailEnabled?: boolean },
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences(userId);
    const result = await this.databaseService.query<NotificationPreferencesRow>(
      `
        INSERT INTO notifications.notification_preferences (
          user_id,
          in_app_enabled,
          email_enabled
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET
          in_app_enabled = EXCLUDED.in_app_enabled,
          email_enabled = EXCLUDED.email_enabled,
          updated_at = NOW()
        RETURNING user_id, in_app_enabled, email_enabled, updated_at;
      `,
      [
        userId,
        input.inAppEnabled ?? current.inAppEnabled,
        input.emailEnabled ?? current.emailEnabled,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Notification preferences update did not return a row');
    }
    return this.toPreferences(row);
  }

  private toItem(row: NotificationRow): NotificationItem {
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      eventCode: row.event_code,
      readAt: this.toIsoStringOrNull(row.read_at),
      createdAt: this.toIsoString(row.created_at),
      projectId: row.project_id ?? null,
      groupId: row.group_id ?? null,
      deliveryProjectId: row.delivery_project_id ?? null,
    };
  }

  private toIsoString(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  private toIsoStringOrNull(value: string | Date | null): string | null {
    return value === null ? null : this.toIsoString(value);
  }

  private toPreferences(
    row: NotificationPreferencesRow,
  ): NotificationPreferences {
    return {
      userId: row.user_id,
      inAppEnabled: row.in_app_enabled,
      emailEnabled: row.email_enabled,
      updatedAt: this.toIsoString(row.updated_at),
    };
  }
}
