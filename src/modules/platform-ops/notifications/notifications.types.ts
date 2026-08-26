export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  eventCode: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  enabled: true;
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
  eventCode: string;
  title: string;
  body: string;
}
