export { WorkspacesModule } from './workspaces.module';
export { WorkspacesService } from './application/workspaces.service';
export { WorkspaceAccessService } from './application/workspace-access.service';
export type { WorkspaceRole } from './infrastructure/workspaces.repository';
export type {
  WorkspaceAccessContract,
  WorkspaceKindContract,
  WorkspaceRoleContract,
} from './contracts/workspace-access.contract';
