import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type {
  EnsureLinkResult,
  ProjectFolderLink,
  ProjectLinkPort,
} from '#kernel/ports/project-link.port';
import { ProjectNameTakenException } from '../../domain/project-name';
import { DeliveryProjectsRepository } from '../../infrastructure/delivery-projects.repository';
import { DeliveryProjectMembersService } from '../../application/delivery-project-members.service';
import { HierarchyAccessService } from '../../application/hierarchy-access.service';
import { HierarchyProjectLinkRepository } from '../infrastructure/hierarchy-project-link.repository';

export interface EnsureProjectLinkInput {
  projectId: string;
  workspaceId: string | null;
  /** service_name, falling back to the repo name. */
  name: string;
  /** Name for a newly auto-created system/delivery-project chain; falls back to `name`. */
  chainName?: string;
  /** `chainName` is a caller-chosen Project name that must be unique in the team. */
  enforceUniqueChainName?: boolean;
  repoFullName: string;
  visibility?: string | null;
  createdBy: string;
  projectStatus: string;
  /** Link into this existing delivery project instead of creating a new chain. */
  deliveryProjectId?: string;
  /** See ProjectLinkPort EnsureProjectLinkInput.accessGrant. Default 'none'. */
  accessGrant?: 'new-repository' | 'none';
}

/**
 * Gives a GROUP-owned provisioned project its hierarchy.repositories row, so
 * developers can be assigned to it and the GitHub team sync has something to
 * hang off.
 *
 * Without this, only repositories created through the create-system path are
 * assignable: form-created projects have no hierarchy row, and
 * hierarchy.repository_assignments references hierarchy.repositories.
 *
 * Best-effort by design. Provisioning a project is a long, multi-step,
 * partially-irreversible operation (GitHub repo, branches, secrets, workflow
 * commit) that has already succeeded by the time this runs. Failing the whole
 * request because a secondary bookkeeping row could not be written would turn
 * a working project into a reported failure — and the compensation path would
 * then delete a perfectly good repository. Failures are logged; the migration
 * backfill and a re-link are the recovery paths.
 */
@Injectable()
export class HierarchyProjectLinkService implements ProjectLinkPort {
  private readonly logger = new Logger(HierarchyProjectLinkService.name);

  constructor(
    private readonly repository: HierarchyProjectLinkRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly deliveryProjectsRepository: DeliveryProjectsRepository,
    private readonly projectMembers: DeliveryProjectMembersService,
  ) {}

  /**
   * Read-only lookup of an ALREADY-linked hierarchy repository id.
   *
   * The assignment UI lives on hierarchy.repositories, but every other surface
   * addresses a project by its provisioned_projects id. This is the one hop
   * between them, so the project page can offer a route into the assignment
   * panel. Returns null when the project has no link (personal workspace, or
   * created before the link existed) — the caller then hides the entry point
   * rather than offering a URL that would 404. Never throws.
   */
  async getLinkedRepositoryId(projectId: string): Promise<string | null> {
    try {
      return await this.repository.findLinkedRepositoryId(projectId);
    } catch (error) {
      this.logger.warn(
        `Could not resolve the hierarchy link for project ${projectId}: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      return null;
    }
  }

  /** See ProjectLinkPort.getProjectFolder. Errors propagate on purpose. */
  getProjectFolder(projectId: string): Promise<ProjectFolderLink | null> {
    return this.repository.findProjectFolder(projectId);
  }

  /** See ProjectLinkPort.getDeliveryProject. Errors propagate on purpose. */
  getDeliveryProject(
    deliveryProjectId: string,
  ): Promise<ProjectFolderLink | null> {
    return this.repository.findDeliveryProject(deliveryProjectId);
  }

  /** See ProjectLinkPort.listDeliveryProjectsForGroup. Errors propagate on purpose. */
  listDeliveryProjectsForGroup(
    groupId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.repository.listActiveDeliveryProjects(groupId);
  }

  /**
   * Returns the linked repository id and its delivery project id, or null
   * when no link was needed or possible. Never throws — see class doc.
   */
  async ensureLink(
    input: EnsureProjectLinkInput,
  ): Promise<EnsureLinkResult | null> {
    // Personal workspace (or none) — there is no hierarchy tree to attach to,
    // and inventing one would put private work inside a group structure.
    if (!input.workspaceId) return null;

    try {
      if (!(await this.repository.isTeamWorkspace(input.workspaceId))) {
        return null;
      }

      const existing =
        await this.repository.findLinkedRepositoryAndDeliveryProject(
          input.projectId,
        );
      if (existing) return existing;

      const name = input.name.trim() || input.repoFullName.split('/').at(-1);
      if (!name) return null;

      const linked = await this.repository.link({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        name,
        ...(input.chainName !== undefined && { chainName: input.chainName }),
        ...(input.enforceUniqueChainName && { enforceUniqueChainName: true }),
        repoFullName: input.repoFullName,
        visibility: input.visibility === 'public' ? 'public' : 'private',
        createdBy: input.createdBy,
        projectStatus: input.projectStatus,
        ...(input.deliveryProjectId !== undefined && {
          deliveryProjectId: input.deliveryProjectId,
        }),
        origin: input.accessGrant === 'new-repository' ? 'created' : 'attached',
      });

      // ALPHACI just created this repository inside a Project: queue GitHub
      // Write for its creator (when a Developer) and every Developer member.
      // Never for an attached, pre-existing repository. Best-effort.
      if (linked && input.accessGrant === 'new-repository') {
        await this.projectMembers.grantForNewRepositoryBestEffort({
          repositoryId: linked.repositoryId,
          deliveryProjectId: linked.deliveryProjectId,
          creatorUserId: input.createdBy,
          assignedBy: input.createdBy,
        });
      }
      return linked;
    } catch (error) {
      // The one loud failure: a Project-name race lost after provisioning
      // started. The caller removes its row and (create paths) the repository.
      if (error instanceof ProjectNameTakenException) throw error;
      this.logger.warn(
        `Could not link project ${input.projectId} into the hierarchy: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      return null;
    }
  }

  /** See ProjectLinkPort.assertProjectNameAvailableForCreate. */
  async assertProjectNameAvailableForCreate(input: {
    workspaceId: string;
    name: string;
  }): Promise<void> {
    const name = input.name.trim();
    // Personal workspaces have no hierarchy, so no Project names to clash with.
    if (!(await this.repository.isTeamWorkspace(input.workspaceId))) return;
    if (await this.repository.isProjectNameTaken(input.workspaceId, name)) {
      throw new ProjectNameTakenException(name);
    }
  }

  /**
   * User-facing gate for an explicit, caller-supplied `deliveryProjectId` on
   * project creation. Unlike `ensureLink`, this THROWS — it runs before any
   * GitHub call, so surfacing a clear 400/404/403 here is exactly what
   * prevents a request from stranding a real repository against an invalid
   * target (see class doc's best-effort rationale, which is why `ensureLink`
   * itself must stay silent — this method is the opposite: the one place a
   * bad deliveryProjectId is loud, and it runs first).
   */
  async assertDeliveryProjectAvailableForCreate(input: {
    deliveryProjectId: string;
    workspaceId: string;
    userId: string;
  }): Promise<void> {
    // 404 (unknown/invisible delivery project) or 403 (visible, but the
    // caller is not a Lead/Admin/platform-admin there) — never a silent pass.
    const { groupId } =
      await this.accessService.assertCanCreateUnderDeliveryProject(
        input.deliveryProjectId,
        input.userId,
      );

    if (groupId !== input.workspaceId) {
      throw new BadRequestException(
        `deliveryProjectId ${input.deliveryProjectId} does not belong to the selected team.`,
      );
    }

    const deliveryProject = await this.deliveryProjectsRepository.findById(
      input.deliveryProjectId,
    );
    if (!deliveryProject || deliveryProject.status !== 'active') {
      throw new BadRequestException(
        `Delivery project ${input.deliveryProjectId} is archived and cannot accept new repositories.`,
      );
    }
  }
}
