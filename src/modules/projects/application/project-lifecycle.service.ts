import { Injectable } from '@nestjs/common';

import type { CreateProjectDto } from '../dto/create-project.dto';
import type { DisconnectProjectDto } from '../dto/disconnect-project.dto';
import type { SetupProjectDto } from '../dto/setup-project.dto';
import {
  ProjectsService,
  type CreateProjectResponse,
  type DisconnectProjectResponse,
  type SetupProjectResponse,
  type SyncProjectsResponse,
} from '../projects.service';

/**
 * Application entry points for creating, setting up, disconnecting and
 * reconciling projects. ProjectsService remains the compatibility facade for
 * older callers while new routes can depend on this narrower use-case slice.
 */
@Injectable()
export class ProjectLifecycleService {
  constructor(private readonly projectsService: ProjectsService) {}

  createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    return this.projectsService.createProject(
      userId,
      userLogin,
      accessToken,
      dto,
    );
  }

  setupProject(
    userId: string,
    accessToken: string | null,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    return this.projectsService.setupProject(userId, accessToken, dto);
  }

  disconnectProject(
    projectId: string,
    userId: string,
    options?: DisconnectProjectDto,
    githubAccessToken?: string | null,
  ): Promise<DisconnectProjectResponse> {
    return this.projectsService.disconnectProject(
      projectId,
      userId,
      options,
      githubAccessToken,
    );
  }

  syncProjects(
    userId: string,
    accessToken: string,
  ): Promise<SyncProjectsResponse> {
    return this.projectsService.syncProjects(userId, accessToken);
  }
}
