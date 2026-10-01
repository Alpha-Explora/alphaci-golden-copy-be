import { Injectable } from '@nestjs/common';

import type { WorkspacesPort } from '#kernel/ports/workspaces.port';
import { WorkspaceAccessService } from './workspace-access.service';
import {
  WorkspacesRepository,
  type WorkspaceMemberSummary,
  type WorkspaceSummary,
} from '../infrastructure/workspaces.repository';

export interface WorkspacesMeResponse {
  enabled: true;
  items: WorkspaceSummary[];
}

@Injectable()
export class WorkspacesService implements WorkspacesPort {
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
}
