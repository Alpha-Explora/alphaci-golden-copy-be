import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';

import { ProjectsRepository } from '../../infrastructure/projects.repository';
import {
  WORKSPACES_PORT,
  type WorkspacesPort,
} from '#kernel/ports/workspaces.port';
import {
  projectRequired,
  repositoryCreateForbidden,
} from '#kernel/rules/persona-access.errors';
import {
  canCreateRepository,
  repositoryCreateRequiresProject,
} from '#kernel/rules/persona-access.rules';

/**
 * Workspace gating for project creation.
 *
 * Extracted from ProjectsService: the Developer/Admin repository creator gate and
 * the workspace resolution rules (explicit group membership or the single-
 * team implicit default).
 */
@Injectable()
export class WorkspaceGateService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(WORKSPACES_PORT)
    private readonly workspacesService: WorkspacesPort | undefined,
  ) {}

  /**
   * Creating a REPOSITORY (the create wizard, existing-repo setup) is a
   * Developer/Admin action, and a Developer always files it into an existing
   * Project. Product owners ('lead') and QA create Projects, not repositories.
   *
   *   admin:        allowed, Project optional (unchanged).
   *   member:       allowed only with a deliveryProjectId (400 PROJECT_REQUIRED).
   *   lead, qa:     403 REPOSITORY_CREATE_FORBIDDEN.
   *
   * Keyed on the GLOBAL app_role (ProjectsRepository.findAppRole folds platform
   * admins into 'admin'), never the workspace role. Whether the Project exists,
   * is active and belongs to the chosen team is checked separately by
   * assertDeliveryProjectAvailableForCreate.
   */
  async assertCanCreateRepositories(
    userId: string,
    deliveryProjectId?: string | null,
  ): Promise<void> {
    const role = await this.projectsRepository.findAppRole(userId);
    if (!canCreateRepository(role)) {
      throw repositoryCreateForbidden();
    }
    if (repositoryCreateRequiresProject(role) && !deliveryProjectId) {
      throw projectRequired();
    }
  }

  /**
   * Workspace for a create that did not name one.
   *
   * This deliberately does NOT fall back to items[0]. That silently picked
   * the caller's oldest workspace by created_at, which - while personal
   * workspaces were auto-created on first read - was reliably the personal one,
   * so projects created outside a team landed somewhere no teammate could see
   * them. With one team the choice is unambiguous; with several it belongs to
   * the caller, not to a sort order.
   */
  async resolveImplicitWorkspaceId(userId: string): Promise<string> {
    const items =
      (await this.workspacesService?.getMyWorkspaces(userId))?.items ?? [];

    if (items.length === 1) {
      const only = items[0];
      if (only) {
        return only.id;
      }
    }
    if (items.length === 0) {
      throw new ForbiddenException(
        'Every project belongs to a team. Ask a team admin to add you to one before creating a project.',
      );
    }
    throw new BadRequestException(
      'Select which team this project belongs to before creating it.',
    );
  }
  /**
   * Workspace a newly-created project belongs to. When the caller creates from
   * inside a group (the "Create project" form passes that group's id), the
   * project is owned by that group — but only if the caller actually belongs to
   * it (or is a global admin), so a project can't be smuggled into a group the
   * caller has no access to. Otherwise it falls back to the caller's default
   * (personal) workspace.
   */
  async resolveWorkspaceIdForCreate(
    userId: string,
    workspaceId?: string | null,
    deliveryProjectId?: string | null,
  ): Promise<string | null> {
    await this.assertCanCreateRepositories(userId, deliveryProjectId);
    if (!workspaceId) {
      // Workspaces disabled entirely: leave the project unscoped as before
      // rather than blocking creation on a module that isn't running.
      if (!this.workspacesService) {
        return null;
      }
      return this.resolveImplicitWorkspaceId(userId);
    }
    const allowed = await this.projectsRepository.canCreateInWorkspace(
      userId,
      workspaceId,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'You are not a member of the selected group.',
      );
    }
    return workspaceId;
  }
}
