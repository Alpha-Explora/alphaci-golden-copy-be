export type WorkspaceRole = 'admin' | 'delegated_lead' | 'member' | 'viewer';

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: 'team';
  role: WorkspaceRole;
}

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface WorkspacesPort {
  getMyWorkspaces(userId: string): Promise<{
    enabled: true;
    items: WorkspaceSummary[];
  }>;
}

export interface WorkspaceAccessPort {
  assertProjectRole(
    projectId: string,
    userId: string,
    allowedRoles: WorkspaceRole[],
  ): Promise<WorkspaceMembership | null>;
  assertWorkspaceRole(
    workspaceId: string,
    userId: string,
    allowedRoles: WorkspaceRole[],
  ): Promise<WorkspaceMembership>;
}

export const WORKSPACES_PORT = Symbol('WorkspacesPort');
export const WORKSPACE_ACCESS_PORT = Symbol('WorkspaceAccessPort');
