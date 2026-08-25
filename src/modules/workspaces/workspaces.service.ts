import { Injectable, NotFoundException } from '@nestjs/common';

import { WorkspaceAccessService } from './workspace-access.service';
import {
  WorkspacesRepository,
  type WorkspaceMemberSummary,
  type WorkspaceRole,
  type WorkspaceSummary,
} from './workspaces.repository';

export interface WorkspacesMeResponse {
  enabled: true;
  items: WorkspaceSummary[];
}

export interface AddWorkspaceMemberInput {
  loginOrEmail: string;
  role: WorkspaceRole;
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly repository: WorkspacesRepository,
    private readonly workspaceAccessService: WorkspaceAccessService,
  ) {}

  /**
   * Every workspace is a team, and a workspace is the only place a project can
   * live. A caller who belongs to no team therefore gets an empty list rather
   * than a workspace conjured for them: this used to lazily create a personal
   * workspace here, which is what put projects somewhere no teammate could see
   * them. Joining a team is now the only way in.
   */
  async getMyWorkspaces(userId: string): Promise<WorkspacesMeResponse> {
    return { enabled: true, items: await this.repository.listForUser(userId) };
  }

  async listMembers(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberSummary[]> {
    await this.workspaceAccessService.assertWorkspaceRole(workspaceId, userId, [
      'admin',
      'delegated_lead',
      'member',
      'viewer',
    ]);
    return this.repository.listMembers(workspaceId);
  }

  async addMember(
    workspaceId: string,
    userId: string,
    input: AddWorkspaceMemberInput,
  ): Promise<WorkspaceMemberSummary> {
    await this.workspaceAccessService.assertWorkspaceRole(workspaceId, userId, [
      'admin',
      'delegated_lead',
    ]);
    const member = await this.repository.addMemberByLoginOrEmail(
      workspaceId,
      input.loginOrEmail,
      input.role,
    );
    if (!member) {
      throw new NotFoundException('User not found');
    }
    return member;
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    memberId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMemberSummary> {
    await this.workspaceAccessService.assertWorkspaceRole(workspaceId, userId, [
      'admin',
      'delegated_lead',
    ]);
    const targetMembership = await this.repository.findMemberById(
      workspaceId,
      memberId,
    );
    if (!targetMembership) {
      throw new NotFoundException('Workspace member not found');
    }
    await this.workspaceAccessService.assertCanChangeOwnerRole(
      workspaceId,
      targetMembership,
      role,
    );
    const member = await this.repository.updateMemberRole(
      workspaceId,
      memberId,
      role,
    );
    if (!member) {
      throw new NotFoundException('Workspace member not found');
    }
    return member;
  }

  async removeMember(
    workspaceId: string,
    userId: string,
    memberId: string,
  ): Promise<{ id: string; removed: true }> {
    await this.workspaceAccessService.assertWorkspaceRole(workspaceId, userId, [
      'admin',
      'delegated_lead',
    ]);
    const targetMembership = await this.repository.findMemberById(
      workspaceId,
      memberId,
    );
    if (!targetMembership) {
      throw new NotFoundException('Workspace member not found');
    }
    await this.workspaceAccessService.assertCanRemoveMember(
      workspaceId,
      targetMembership,
    );
    const removed = await this.repository.removeMember(workspaceId, memberId);
    if (!removed) {
      throw new NotFoundException('Workspace member not found');
    }
    return { id: removed.id, removed: true };
  }
}
