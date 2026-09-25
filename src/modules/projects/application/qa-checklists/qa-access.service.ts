import { Injectable } from '@nestjs/common';

import { ProjectsRepository } from '../../infrastructure/projects.repository';

/**
 * Authorization for the QA checklists slice, built entirely on top of
 * ProjectsRepository's existing, already-tested predicates rather than new
 * SQL. This deliberately does NOT use WorkspaceAccessService.assertWorkspaceRole
 * or ProjectsRepository.findByIdAndUser(..., allowedRoles) — both of those
 * read orgs.workspace_members.role (the per-workspace title: admin /
 * delegated_lead / member), which is unrelated to identity.app_users.app_role
 * (the global persona added in Slice 1: admin | lead | qa | member). A
 * workspace's "Lead" for QA-checklist purposes is a global app_role of 'lead'
 * (or 'admin'), scoped down to workspaces they are actually a member of.
 *
 * Contract this enforces (see the controller for where each is applied):
 *   - non-member of the workspace -> 404 (canAccessWorkspace false)
 *   - member but not lead/admin, attempting a write -> 403 (canManage false)
 */
@Injectable()
export class QaAccessService {
  constructor(private readonly projectsRepository: ProjectsRepository) {}

  /**
   * True for an active member of the workspace, or any global admin. This is
   * the visibility gate: false means the workspace does not exist "for this
   * user", which the caller turns into a 404, not a 403 — a caller who isn't
   * in the workspace should not learn anything about it, including whether
   * checklists exist there.
   */
  async canAccessWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    return this.projectsRepository.canCreateInWorkspace(userId, workspaceId);
  }

  /**
   * True for a global admin or lead. This is the write gate. Callers must
   * check canAccessWorkspace() first so a non-member gets 404 rather than a
   * 403 that would leak "this workspace exists, you're just not allowed."
   */
  async canManage(userId: string): Promise<boolean> {
    return this.projectsRepository.isGlobalProjectCreator(userId);
  }

  /**
   * Project-level visibility — "anyone who can see the project" — reusing
   * ProjectsRepository's default (no allowedRoles) visibility predicate.
   * Returns the project's workspace_id when visible, or null when the
   * project does not exist or is not visible to this user (both map to 404).
   */
  async findVisibleProjectWorkspace(
    projectId: string,
    userId: string,
  ): Promise<{ workspaceId: string | null } | null> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      return null;
    }
    return { workspaceId: project.workspace_id ?? null };
  }
}
