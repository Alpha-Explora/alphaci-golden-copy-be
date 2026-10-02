import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';

import { ProjectsRepository } from '../../infrastructure/projects.repository';
import {
  PROJECT_REQUIREMENTS_READINESS,
  type ProjectRequirementsReadinessPort,
} from '#kernel/ports/project-requirements-readiness.port';
import {
  WORKSPACES_PORT,
  type WorkspacesPort,
} from '#kernel/ports/workspaces.port';
import {
  projectRequired,
  repositoryCreateForbidden,
} from '#kernel/rules/persona-access.errors';
import { assertProjectHasFeatureForRepositoryCreate } from '#kernel/rules/project-features.gate';
import {
  canCreateRepository,
  repositoryCreateRequiresFeature,
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
    @Optional()
    @Inject(PROJECT_REQUIREMENTS_READINESS)
    private readonly requirementsReadiness?: ProjectRequirementsReadinessPort,
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
   * A member also needs at least one active Feature in the Project (409
   * PROJECT_FEATURES_REQUIRED) unless `requireFeatures` is false. Admins are
   * exempt and the rule is skipped when the QA capability is off. Callers that
   * run AFTER the GitHub repository exists pass `requireFeatures: false`: the
   * gate already passed up front, and refusing now (a lead archived the last
   * Feature mid-provisioning) would strand the repository.
   *
   * Keyed on the GLOBAL app_role (ProjectsRepository.findAppRole folds platform
   * admins into 'admin'), never the workspace role. Whether the Project exists,
   * is active and belongs to the chosen team is checked separately by
   * assertDeliveryProjectAvailableForCreate.
   */
  async assertCanCreateRepositories(
    userId: string,
    deliveryProjectId?: string | null,
    options: { requireFeatures?: boolean } = {},
  ): Promise<void> {
    const role = await this.projectsRepository.findAppRole(userId);
    if (!canCreateRepository(role)) {
      throw repositoryCreateForbidden();
    }
    if (repositoryCreateRequiresProject(role) && !deliveryProjectId) {
      throw projectRequired();
    }
    if (options.requireFeatures !== false) {
      await this.assertProjectHasFeatures(userId, deliveryProjectId, role);
    }
  }

  /**
   * The Feature rule alone. Callers that validate the Project's existence,
   * team and availability themselves (createProject, setup) run it AFTER that
   * check, so a member cannot learn whether another team's Project has
   * Features from the 409-versus-404 difference.
   */
  async assertProjectHasFeatures(
    userId: string,
    deliveryProjectId?: string | null,
    knownRole?: Awaited<ReturnType<ProjectsRepository['findAppRole']>>,
  ): Promise<void> {
    const role =
      knownRole ?? (await this.projectsRepository.findAppRole(userId));
    if (!repositoryCreateRequiresFeature(role)) {
      return;
    }
    if (!this.requirementsReadiness) {
      // Fail closed: an unwired port must not silently lift the rule.
      throw new InternalServerErrorException(
        'Project requirements readiness is not available.',
      );
    }
    await assertProjectHasFeatureForRepositoryCreate(
      this.requirementsReadiness,
      role,
      deliveryProjectId,
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
    deliveryProjectId?: string | null,
    options: { requireFeatures?: boolean } = {},
  ): Promise<string | null> {
    await this.assertCanCreateRepositories(userId, deliveryProjectId, options);
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
