import { Injectable } from '@nestjs/common';

import { ProjectDriftRepairService } from './project-drift-repair.handler';
import type {
  ProjectDriftRepairAction,
  ProjectDriftRepairResponse,
} from '#kernel/ports/deployment-runtime.port';

/** Application boundary for user-approved project drift repairs. */
@Injectable()
export class ProjectDriftRepairApplicationService {
  constructor(private readonly driftRepairService: ProjectDriftRepairService) {}

  repair(
    projectId: string,
    findingId: string,
    userId: string,
    action: ProjectDriftRepairAction,
    githubAccessToken: string | null,
  ): Promise<ProjectDriftRepairResponse> {
    return this.driftRepairService.repair(
      projectId,
      findingId,
      userId,
      action,
      githubAccessToken,
    );
  }
}
