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
   * 'github' = ingested from the repository's GitHub activity (pushes, pull
   * requests, branches), not recorded by ALPHACI itself.
   */
  scope: 'repository' | 'project' | 'github';
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

/** One GitHub event, already mapped to an audit row by the projects module. */
export interface ExternalAuditEvent {
  /** Dedupe key, `github:<event id>`; unique across audit.audit_events. */
  externalId: string;
  eventCode: string;
  message: string;
  metadata: Record<string, unknown>;
  /** The GitHub login that acted; resolved to an ALPHACI user when it maps to one. */
  actorLogin: string | null;
  /** When it happened on GitHub (event.created_at), not when it was ingested. */
  occurredAt: string;
}

export interface ExternalAuditBatch {
  projectId: string;
  workspaceId: string | null;
  events: ExternalAuditEvent[];
}

/**
 * Last SUCCESSFUL GitHub activity sync of one repository, keyed by its
 * lower-case full name. Failed attempts are not stored: the previous ETag and
 * time stay, so the next attempt resumes from the last good state.
 */
export interface GithubActivitySyncState {
  etag: string | null;
  syncedAt: string;
}

/**
 * Ingest capability for activity that happened outside ALPHACI. The projects
 * module knows which repository is which project and talks to GitHub; the
 * audit module owns the table and the sync bookkeeping.
 */
export interface AuditExternalIngestPort {
  /** False when AUDIT_EVENTS_ENABLED is off: nothing is recorded or read. */
  isRecording(): boolean;
  /** The subset of `externalIds` that are not stored yet. */
  findUnrecordedExternalIds(externalIds: string[]): Promise<Set<string>>;
  /** Insert ON CONFLICT DO NOTHING; returns how many rows were new. */
  ingestExternalEvents(
    batch: ExternalAuditBatch,
  ): Promise<{ inserted: number }>;
  getGithubSyncState(
    repoFullName: string,
  ): Promise<GithubActivitySyncState | null>;
  saveGithubSyncState(
    repoFullName: string,
    state: GithubActivitySyncState,
  ): Promise<void>;
}

export const AUDIT_QUERY_PORT = Symbol('AuditQueryPort');
export const AUDIT_EXTERNAL_INGEST_PORT = Symbol('AuditExternalIngestPort');
export const AUDIT_SECURITY_PORT = Symbol('AuditSecurityPort');
