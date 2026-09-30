export type NotificationSeverityContract =
  | 'info'
  | 'success'
  | 'warning'
  | 'error';

export interface NotificationContract {
  id: string;
  userId: string;
  title: string;
  body: string;
  severity: NotificationSeverityContract;
  readAt: string | null;
  /** Deep-link ids (spec 8.6); mirrors NotificationItem on the wire. */
  projectId: string | null;
  groupId: string | null;
  deliveryProjectId: string | null;
}
