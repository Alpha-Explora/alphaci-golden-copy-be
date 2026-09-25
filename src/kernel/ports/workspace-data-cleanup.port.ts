/**
 * Identity Access deletes workspaces; other contexts own data keyed by a
 * workspace id they cannot hold a foreign key to (check-schema-ownership
 * refuses new cross-context FKs). This narrow port lets the deletion flow ask
 * those owners to remove it, without Identity Access knowing what it is.
 */
export interface WorkspaceDataCleanupPort {
  /** Removes data owned by the implementing context for a deleted workspace. Idempotent. */
  purgeWorkspace(workspaceId: string): Promise<{ removed: number }>;
}

export const WORKSPACE_DATA_CLEANUP = Symbol('WorkspaceDataCleanupPort');
