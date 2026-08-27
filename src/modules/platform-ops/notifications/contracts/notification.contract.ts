export type NotificationSeverityContract =
  'info' | 'success' | 'warning' | 'error';

export interface NotificationContract {
  id: string;
  userId: string;
  title: string;
  body: string;
  severity: NotificationSeverityContract;
  readAt: string | null;
}
