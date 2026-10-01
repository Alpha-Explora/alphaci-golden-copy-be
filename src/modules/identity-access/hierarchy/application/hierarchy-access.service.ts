import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  type AppRole,
  PlatformAdminAccessService,
} from '#modules/identity-access/admin/index.js';
import {
  projectCreateForbidden,
  repositoryCreateForbidden,
} from '#kernel/rules/persona-access.errors';
import {
  canCreateProjectFolder,
  canCreateRepository,
} from '#kernel/rules/persona-access.rules';
import {
  AssignmentsRepository,
  type AssignmentRecord,
} from '../infrastructure/assignments.repository';
import { DeliveryProjectsRepository } from '../infrastructure/delivery-projects.repository';
import {
  type ActiveMembership,
  GroupsRepository,
} from '../infrastructure/groups.repository';
import type { GroupRole } from '../domain/hierarchy.types';
import {
  RepositoriesRepository,
  type RepositoryRecord,
} from '../infrastructure/repositories.repository';
import { SystemsRepository } from '../infrastructure/systems.repository';

// `admin` = top group-membership tier ("Lead", formerly `owner`) — an
// entirely different system from PlatformAdminsRepository / isPlatformAdmin
// below, which reads identity.platform_admins ('admin' | 'super_admin').
// Same literal string, two unrelated authorities — do not conflate.
const ROLE_RANK: Record<GroupRole, number> = {
  admin: 4,
  delegated_lead: 3,
  member: 2,
  viewer: 1,
};

/**
 * Mirrors WorkspaceAccessService's imperative assert-or-throw pattern (plan
 * §2.0 — no declarative @Roles() decorator in this codebase). Every assert
 * method here throws — none return null/undefined and let a caller
 * accidentally proceed unauthorized. This is a deliberate, explicit fix for
 * the known fail-open shape in WorkspaceAccessService.assertProjectRole
 * (returns null on missing membership; see last-owner safety rule check 1) — that bug is
 * NOT repeated here.
 *
 * 404-vs-403 convention (resource visibility rule): a caller who cannot see a resource at
 * all gets 404 ("not found"); a caller who can see it but lacks the required
 * role gets 403 ("insufficient role").
 */
@Injectable()
export class HierarchyAccessService {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly systemsRepository: SystemsRepository,
    private readonly deliveryProjectsRepository: DeliveryProjectsRepository,
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly assignmentsRepository: AssignmentsRepository,
    private readonly platformAdminAccessService: PlatformAdminAccessService,
  ) {}

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const role = await this.platformAdminAccessService.findRole(userId);
    if (role !== null) return true;
    // A global 'admin' app_role is also a full override in the single-role
    // model, even without a platform_admins row.
    return (
      (await this.platformAdminAccessService.findAppRole(userId)) === 'admin'
    );
  }

  /** The user's global hierarchy role (admin | lead | member). */
  async getAppRole(userId: string): Promise<AppRole> {
    return this.platformAdminAccessService.findAppRole(userId);
  }

  // ─── Global create capability (single-role model) ─────────────────────
  //
  // The capability to CREATE things is governed by the GLOBAL app_role assigned
  // in the Admin Console - NOT the per-group membership tier (persona rules in
  // #kernel/rules/persona-access.rules):
  //   - Projects (delivery projects / empty project folders): lead | admin.
  //   - Repositories: member (Developer) | admin, always INTO a Project.
  // A user still has to be an active member of the group (non-members keep
  // getting a 404 that hides the group's existence). Platform admins (and
  // global 'admin', via isPlatformAdmin) override the membership requirement.

  /** Throws 403 PROJECT_CREATE_FORBIDDEN unless the persona may create Projects. */
  private async assertCanCreateProjectRole(userId: string): Promise<void> {
    // isPlatformAdmin already covers platform_admins rows AND global 'admin'.
    if (await this.isPlatformAdmin(userId)) return;
    if (!canCreateProjectFolder(await this.getAppRole(userId))) {
      throw projectCreateForbidden();
    }
  }

  /** Throws 403 REPOSITORY_CREATE_FORBIDDEN unless the persona may create repositories. */
  private async assertCanCreateRepositoryRole(userId: string): Promise<void> {
    if (await this.isPlatformAdmin(userId)) return;
    if (!canCreateRepository(await this.getAppRole(userId))) {
      throw repositoryCreateForbidden();
    }
  }

  /**
   * Create a system directly under a group (system + auto Project + first
   * repository in one step) - it creates a Project AND a repository, so only a
   * persona allowed both (admin) passes. 404 group -> 403 role.
   */
  async assertCanCreateInGroup(groupId: string, userId: string): Promise<void> {
    if (await this.isPlatformAdmin(userId)) {
      const group = await this.groupsRepository.findGroupById(groupId);
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      return;
    }
    await this.assertGroupMembership(groupId, userId);
    await this.assertCanCreateProjectRole(userId);
    await this.assertCanCreateRepositoryRole(userId);
  }

  /**
   * Create an empty Project folder (no repository) under a group: lead | admin.
   * 404 group -> 403 PROJECT_CREATE_FORBIDDEN.
   */
  async assertCanCreateProjectInGroup(
    groupId: string,
    userId: string,
  ): Promise<void> {
    if (await this.isPlatformAdmin(userId)) {
      const group = await this.groupsRepository.findGroupById(groupId);
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      return;
    }
    await this.assertGroupMembership(groupId, userId);
    await this.assertCanCreateProjectRole(userId);
  }

  /** Create under a system (delivery projects): lead | admin. 404 system -> 403 role. */
  async assertCanCreateUnderSystem(
    systemId: string,
    userId: string,
  ): Promise<{ groupId: string }> {
    const groupId = await this.systemsRepository.findGroupIdForSystem(systemId);
    if (!groupId) {
      throw new NotFoundException('System not found');
    }
    if (!(await this.isPlatformAdmin(userId))) {
      await this.assertGroupMembership(groupId, userId);
      await this.assertCanCreateProjectRole(userId);
    }
    return { groupId };
  }

  /**
   * Create under a delivery project (repositories): member (an active member
   * of the Project's team) | admin. 404 dp / non-member -> 403
   * REPOSITORY_CREATE_FORBIDDEN for lead and qa.
   */
  async assertCanCreateUnderDeliveryProject(
    deliveryProjectId: string,
    userId: string,
  ): Promise<{ groupId: string }> {
    const groupId =
      await this.deliveryProjectsRepository.findGroupIdForDeliveryProject(
        deliveryProjectId,
      );
    if (!groupId) {
      throw new NotFoundException('Delivery project not found');
    }
    if (!(await this.isPlatformAdmin(userId))) {
      await this.assertGroupMembership(groupId, userId);
      await this.assertCanCreateRepositoryRole(userId);
    }
    return { groupId };
  }

  /** Any active member — used for read endpoints scoped to "active member". */
  async assertGroupMembership(
    groupId: string,
    userId: string,
  ): Promise<ActiveMembership> {
    const membership = await this.groupsRepository.findActiveMembership(
      groupId,
      userId,
    );
    if (!membership) {
      throw new NotFoundException('Group not found');
    }
    return membership;
  }

  /** Active member AND role check. Throws 404 then 403 — never returns null. */
  async assertGroupRole(
    groupId: string,
    userId: string,
    allowedRoles: GroupRole[],
  ): Promise<ActiveMembership> {
    const membership = await this.assertGroupMembership(groupId, userId);
    this.assertRoleRank(membership.role, allowedRoles);
    return membership;
  }

  /**
   * Group management roles (default owner/admin) OR platform admin.
   * Platform admin bypasses the membership requirement entirely because
   * platform administrators have full system-wide authority.
   */
  async assertGroupManagerOrPlatformAdmin(
    groupId: string,
    userId: string,
    allowedRoles: GroupRole[] = ['admin', 'delegated_lead'],
  ): Promise<{
    viaPlatformAdmin: boolean;
    membership: ActiveMembership | null;
  }> {
    if (await this.isPlatformAdmin(userId)) {
      // Platform admin overrides scope but the group must still exist.
      const group = await this.groupsRepository.findGroupById(groupId);
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      return { viaPlatformAdmin: true, membership: null };
    }
    const membership = await this.assertGroupRole(
      groupId,
      userId,
      allowedRoles,
    );
    return { viaPlatformAdmin: false, membership };
  }

  // ─── Systems ──────────────────────────────────────────────────────────
  async assertSystemMembership(
    systemId: string,
    userId: string,
  ): Promise<{ groupId: string }> {
    const groupId = await this.systemsRepository.findGroupIdForSystem(systemId);
    if (!groupId) {
      throw new NotFoundException('System not found');
    }
    if (await this.isPlatformAdmin(userId)) {
      return { groupId };
    }
    await this.assertGroupMembership(groupId, userId);
    return { groupId };
  }

  async assertSystemManager(
    systemId: string,
    userId: string,
  ): Promise<{ groupId: string; viaPlatformAdmin: boolean }> {
    const groupId = await this.systemsRepository.findGroupIdForSystem(systemId);
    if (!groupId) {
      throw new NotFoundException('System not found');
    }
    const { viaPlatformAdmin } = await this.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
    );
    return { groupId, viaPlatformAdmin };
  }

  // ─── Delivery projects ───────────────────────────────────────────────
  async assertDeliveryProjectMembership(
    deliveryProjectId: string,
    userId: string,
  ): Promise<{ groupId: string }> {
    const groupId =
      await this.deliveryProjectsRepository.findGroupIdForDeliveryProject(
        deliveryProjectId,
      );
    if (!groupId) {
      throw new NotFoundException('Delivery project not found');
    }
    if (await this.isPlatformAdmin(userId)) {
      return { groupId };
    }
    await this.assertGroupMembership(groupId, userId);
    return { groupId };
  }

  async assertDeliveryProjectManager(
    deliveryProjectId: string,
    userId: string,
  ): Promise<{ groupId: string; viaPlatformAdmin: boolean }> {
    const groupId =
      await this.deliveryProjectsRepository.findGroupIdForDeliveryProject(
        deliveryProjectId,
      );
    if (!groupId) {
      throw new NotFoundException('Delivery project not found');
    }
    const { viaPlatformAdmin } = await this.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
    );
    return { groupId, viaPlatformAdmin };
  }

  // ─── Repositories ─────────────────────────────────────────────────────
  async assertRepositoryManagerOrPlatformAdmin(
    repositoryId: string,
    userId: string,
  ): Promise<{ groupId: string; viaPlatformAdmin: boolean }> {
    const groupId =
      await this.repositoriesRepository.findGroupIdForRepository(repositoryId);
    if (!groupId) {
      throw new NotFoundException('Repository not found');
    }
    const { viaPlatformAdmin } = await this.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
    );
    return { groupId, viaPlatformAdmin };
  }

  /**
   * The ONE choke point for "is this developer allowed to touch this exact
   * repository" (repository access contract key implementation note). Every developer-facing
   * repository/config endpoint must call this — no ad-hoc role checks
   * duplicated inline. Repository non-existence and "exists but no active
   * assignment" are deliberately indistinguishable (both 404) so an
   * unassigned developer cannot fingerprint repository existence (security contract).
   */
  async assertActiveRepositoryAssignment(
    repositoryId: string,
    userId: string,
  ): Promise<AssignmentRecord> {
    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository || repository.status !== 'active') {
      throw new NotFoundException('Repository not found');
    }
    const assignment =
      await this.assignmentsRepository.findActiveForUserAndRepository(
        repositoryId,
        userId,
      );
    if (!assignment) {
      throw new NotFoundException('Repository not found');
    }
    return assignment;
  }

  /**
   * GET /repositories/:repositoryId visibility: active-assignment holder OR
   * owner/admin/platform admin of the owning group. 404 for everyone else.
   */
  async assertRepositoryVisible(
    repositoryId: string,
    userId: string,
  ): Promise<{
    repository: RepositoryRecord;
    viaManager: boolean;
    viaPlatformAdmin: boolean;
  }> {
    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) {
      throw new NotFoundException('Repository not found');
    }

    if (await this.isPlatformAdmin(userId)) {
      return { repository, viaManager: true, viaPlatformAdmin: true };
    }

    const membership = await this.groupsRepository.findActiveMembership(
      repository.groupId,
      userId,
    );
    if (membership && ROLE_RANK[membership.role] >= ROLE_RANK.delegated_lead) {
      return { repository, viaManager: true, viaPlatformAdmin: false };
    }

    const assignment =
      await this.assignmentsRepository.findActiveForUserAndRepository(
        repositoryId,
        userId,
      );
    if (!assignment) {
      throw new NotFoundException('Repository not found');
    }
    return { repository, viaManager: false, viaPlatformAdmin: false };
  }

  private assertRoleRank(role: GroupRole, allowedRoles: GroupRole[]): void {
    const minimumRank = Math.min(
      ...allowedRoles.map((allowed) => ROLE_RANK[allowed]),
    );
    if (ROLE_RANK[role] < minimumRank) {
      throw new ForbiddenException('Insufficient group role');
    }
  }
}
