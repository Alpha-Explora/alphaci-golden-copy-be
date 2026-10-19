export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  eventCode: string;
  readAt: string | null;
  createdAt: string;
  /**
   * Deep-link data (spec 8.6). The frontend derives routes from eventCode plus
   * these ids; the API never returns frontend URLs. groupId and
   * deliveryProjectId are resolved at read time through
   * hierarchy.repositories.provisioned_project_id and are null when the
   * project is not filed under a folder (or the project is gone).
   */
  projectId: string | null;
  groupId: string | null;
  deliveryProjectId: string | null;
}

export interface NotificationsResponse {
  enabled: boolean;
  items: NotificationItem[];
  unreadCount: number;
}

export interface NotificationPreferences {
  userId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  updatedAt: string;
}

export interface CreateNotificationInput {
  userId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  sourceEventId?: string | null;
  eventCode: string;
  title: string;
  body: string;
}
