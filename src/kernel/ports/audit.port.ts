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

/** An audit event as shown on a repository's Audit tab. */
export interface ProjectAuditEventItem extends AuditEventRecord {
  actorLogin: string | null;
  /**
   * 'repository' = recorded against this repository; 'project' = recorded
   * against the delivery Project the repository is filed under (requirement
   * and checklist events), so it appears on every repository of that Project.
   */
  scope: 'repository' | 'project';
}

/**
 * The caller must already have been authorised to see `projectId`: the
 * projects module owns that visibility predicate, so the query takes no user.
 */
export interface ProjectAuditQuery {
  projectId: string;
  /** The delivery Project the repository belongs to, when it has one. */
  deliveryProjectId?: string | null;
  limit?: number;
  /** Exclusive ISO createdAt cursor: only strictly older events are returned. */
  before?: string | null;
}

export interface ProjectAuditPage {
  enabled: boolean;
  items: ProjectAuditEventItem[];
  /** createdAt cursor to pass as `before` for the next page, or null. */
  next: string | null;
}

/** Read capability exposed by platform-ops to project read models. */
export interface AuditQueryPort {
  listProjectEvents(query: ProjectAuditQuery): Promise<ProjectAuditPage>;
}

/** Security-sensitive audit capability whose writes are always enabled. */
export interface AuditSecurityPort {
  recordAlwaysOn(input: AuditEventInput): Promise<void>;
}

export const AUDIT_QUERY_PORT = Symbol('AuditQueryPort');
export const AUDIT_SECURITY_PORT = Symbol('AuditSecurityPort');
