import { Injectable } from '@nestjs/common';

import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../infrastructure/projects.repository';
import { canManageRequirements } from '#kernel/rules/persona-access.rules';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

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
   * True for a global admin or lead (canManageRequirements). This is the
   * write gate - independent of who may create repositories. Callers must
   * check canAccessWorkspace() first so a non-member gets 404 rather than a
   * 403 that would leak "this workspace exists, you're just not allowed."
   */
  async canManage(userId: string): Promise<boolean> {
    return canManageRequirements(
      await this.projectsRepository.findAppRole(userId),
    );
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

  /**
   * The full project row, when visible to this user (same default-visibility
   * predicate as findVisibleProjectWorkspace above, one query). Used by the
   * QA verification-runs slice (Slice 3), which — unlike the checklists
   * slice above — is entirely project-scoped and needs more than just the
   * workspace id off the row: repo_full_name for commit resolution, and
   * user_id (the owner) alongside workspace_id for notification recipients.
   * Kept here rather than duplicated in qa-runs so there is exactly one
   * "is this project visible to this caller" query path.
   */
  async findVisibleProject(
    projectId: string,
    userId: string,
  ): Promise<ProvisionedProjectRow | null> {
    return this.projectsRepository.findByIdAndUser(projectId, userId);
  }

  /**
   * The caller's effective global persona (admin | lead | qa | member),
   * platform_admins override included. This is the QA verification-runs
   * slice's entire role model — unlike canManage() above (admin/lead only,
   * built for the checklists slice), qa-runs' permission matrix also grants
   * some actions to 'qa' and 'member', so callers need the raw role rather
   * than a single collapsed boolean.
   */
  async findAppRole(userId: string): Promise<PlatformAppRole> {
    return this.projectsRepository.findAppRole(userId);
  }

  /** The owning user of a provisioned project - a notification recipient. */
  async findProjectOwnerId(projectId: string): Promise<string | null> {
    return this.projectsRepository.findOwnerId(projectId);
  }

  /** Active workspace members whose global persona is 'lead' — notification recipients. */
  async listWorkspaceLeadIds(workspaceId: string): Promise<string[]> {
    return this.projectsRepository.listWorkspaceLeadIds(workspaceId);
  }

  /** Active workspace members whose persona is 'lead' or 'member' (developer). */
  async listWorkspaceLeadAndDeveloperIds(
    workspaceId: string,
  ): Promise<string[]> {
    return this.projectsRepository.listWorkspaceLeadAndDeveloperIds(
      workspaceId,
    );
  }

  /** Active workspace members whose persona is 'qa'. */
  async listWorkspaceQaIds(workspaceId: string): Promise<string[]> {
    return this.projectsRepository.listWorkspaceQaIds(workspaceId);
  }
}
