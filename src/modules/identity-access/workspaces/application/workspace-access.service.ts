import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  WorkspacesRepository,
  type WorkspaceMembership,
  type WorkspaceRole,
} from '../infrastructure/workspaces.repository';
import type { WorkspaceAccessPort } from '#kernel/ports/workspaces.port';

// `admin` = top workspace-membership tier ("Lead", formerly `owner`) — NOT
// the unrelated identity.platform_admins tier. See WorkspaceRole doc comment.
const ROLE_RANK: Record<WorkspaceRole, number> = {
  admin: 4,
  delegated_lead: 3,
  member: 2,
  viewer: 1,
};

@Injectable()
export class WorkspaceAccessService implements WorkspaceAccessPort {
  constructor(private readonly repository: WorkspacesRepository) {}

  async assertWorkspaceRole(
    workspaceId: string,
    userId: string,
    allowedRoles: WorkspaceRole[],
  ): Promise<WorkspaceMembership> {
    const membership = await this.repository.findMembership(
      workspaceId,
      userId,
    );
    if (!membership) {
      throw new NotFoundException('Workspace not found');
    }
    this.assertRole(membership.role, allowedRoles);
    return membership;
  }

  async assertProjectRole(
    projectId: string,
    userId: string,
    allowedRoles: WorkspaceRole[],
  ): Promise<WorkspaceMembership | null> {
    const membership = await this.repository.findProjectMembership(
      projectId,
      userId,
    );
    if (!membership) {
      return null;
    }
    this.assertRole(membership.role, allowedRoles);
    return membership;
  }

  private assertRole(role: WorkspaceRole, allowedRoles: WorkspaceRole[]): void {
    const minimumRank = Math.min(
      ...allowedRoles.map((allowed) => ROLE_RANK[allowed]),
    );
    if (ROLE_RANK[role] < minimumRank) {
      throw new ForbiddenException('Insufficient workspace role');
    }
  }
}
