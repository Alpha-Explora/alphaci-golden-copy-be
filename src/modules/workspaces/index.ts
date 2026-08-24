/**
 * Workspaces — public API.
 *
 * Partial and grown migrate-on-touch; see audit/index.ts for the reasoning.
 */

// Behaviour: the role check every project-scoped mutation goes through.
export { WorkspaceAccessService } from './workspace-access.service';
export { WorkspacesModule } from './workspaces.module';
