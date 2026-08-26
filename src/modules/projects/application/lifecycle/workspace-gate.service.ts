import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import { ProjectsRepository } from '../../projects.repository';
import { WorkspacesService } from '#modules/identity-access/index.js';

/**
 * Workspace gating for project creation.
 *
 * Extracted verbatim from ProjectsService: the Lead/Admin creator gate and
 * the workspace resolution rules (explicit group membership or the single-
 * team implicit default).
 */
@Injectable()
export class WorkspaceGateService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly workspacesService: WorkspacesService | undefined,
  ) {}

  /**
   * Creating a project is a Lead/Admin action, not a Developer one.
   *
   * This is the same standard HierarchyAccessService.assertGlobalCreatorRole
   * applies to systems, delivery projects and repositories - a project is the
   * same kind of act, and having two different answers to "who may create
   * things here" is how a product ends up with a role model nobody can predict.
   *
   * Deliberately keyed on the GLOBAL app_role rather than the workspace role: a
   * workspace delegated_lead whose app_role is member is a Developer with
   * extra rights inside one team, not someone who may provision repositories.
   */
  async assertCanCreateProjects(userId: string): Promise<void> {
    if (await this.projectsRepository.isGlobalProjectCreator(userId)) {
      return;
    }
    throw new ForbiddenException(
      'Only a Lead or Admin can create projects. Ask a team lead to create it for you.',
    );
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
  ): Promise<string | null> {
    await this.assertCanCreateProjects(userId);
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
