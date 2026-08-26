export interface AuditEventContract {
  eventCode: string;
  actorUserId: string | null;
  workspaceId?: string;
  projectId?: string;
  message: string;
  metadata: Record<string, unknown>;
  occurredAt?: string;
}
