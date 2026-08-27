export interface AuditEventInput {
  workspaceId?: string | null;
  projectId?: string | null;
  actorUserId?: string | null;
  eventCode: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  actorUserId: string | null;
  eventCode: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Read capability exposed by platform-ops to project read models. */
export interface AuditQueryPort {
  listProjectEvents(
    projectId: string,
    userId: string,
  ): Promise<{ enabled: boolean; items: AuditEventRecord[] }>;
}

/** Security-sensitive audit capability whose writes are always enabled. */
export interface AuditSecurityPort {
  recordAlwaysOn(input: AuditEventInput): Promise<void>;
}

export const AUDIT_QUERY_PORT = Symbol('AuditQueryPort');
export const AUDIT_SECURITY_PORT = Symbol('AuditSecurityPort');
