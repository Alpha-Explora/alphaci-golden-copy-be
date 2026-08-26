export type WorkspaceKindContract = 'personal' | 'team';
export type WorkspaceRoleContract = 'owner' | 'admin' | 'member';

export interface WorkspaceAccessContract {
  workspaceId: string;
  userId: string;
  kind: WorkspaceKindContract;
  role: WorkspaceRoleContract;
  canWrite: boolean;
}
