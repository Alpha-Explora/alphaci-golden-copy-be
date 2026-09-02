import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import type { WorkflowFileMetadata } from '../workflows/index';
import { LocalCiRunsProvider } from './local-ci-runs.provider';
import type {
  CiRunsProjectContext,
  ProjectCiRun,
} from './project-ci-runs.types';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../projects.repository';

export interface ProjectCiRunsResponse {
  enabled: boolean;
  mode: 'local_mock';
  liveGithubEnabled: boolean;
  githubActionsUrl: string;
  runs: ProjectCiRun[];
}

@Injectable()
export class ProjectCiRunsService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly provider: LocalCiRunsProvider = new LocalCiRunsProvider(),
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async listRuns(
    projectId: string,
    userId: string,
  ): Promise<ProjectCiRunsResponse> {
    const context = await this.getProjectContext(projectId, userId);
    if (!this.enabled()) {
      return {
        enabled: false,
        mode: 'local_mock',
        liveGithubEnabled: this.liveGithubEnabled(),
        githubActionsUrl: this.githubActionsUrl(context.repoFullName),
        runs: [],
      };
    }

    return {
      enabled: true,
      mode: 'local_mock',
      liveGithubEnabled: this.liveGithubEnabled(),
      githubActionsUrl: this.githubActionsUrl(context.repoFullName),
      runs: await this.provider.listRuns(context),
    };
  }

  async getRun(
    projectId: string,
    runId: string,
    userId: string,
  ): Promise<ProjectCiRun> {
    if (!this.enabled()) {
      throw new BadRequestException('CI run tracking is disabled');
    }

    const context = await this.getProjectContext(projectId, userId);
    const run = await this.provider.getRun(context, runId);
    if (!run) {
      throw new NotFoundException('CI run not found');
    }

    return run;
  }

  async rerun(
    projectId: string,
    runId: string,
    userId: string,
  ): Promise<{ enabled: false; runId: string; reason: string }> {
    await this.getProjectContext(projectId, userId);
    return {
      enabled: false,
      runId,
      reason:
        'Manual rerun requires a live GitHub Actions integration, which is not implemented yet.',
    };
  }

  private async getProjectContext(
    projectId: string,
    userId: string,
  ): Promise<CiRunsProjectContext> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    return {
      projectId,
      repoFullName: row.repo_full_name,
      workflowFiles: this.workflowFilesFromRow(row),
    };
  }

  private workflowFilesFromRow(
    row: Pick<ProvisionedProjectRow, 'workflow_path' | 'project_options'>,
  ): Array<Pick<WorkflowFileMetadata, 'name' | 'path'>> {
    const files = row.project_options?.['workflowFiles'];
    if (Array.isArray(files)) {
      return files
        .filter((file): file is Pick<WorkflowFileMetadata, 'name' | 'path'> => {
          return (
            typeof (file as { name?: unknown }).name === 'string' &&
            typeof (file as { path?: unknown }).path === 'string'
          );
        })
        .map((file) => ({
          name: file.name,
          path: file.path,
        }));
    }

    return row.workflow_path
      ? [{ name: 'ALPHACI Workflow', path: row.workflow_path }]
      : [];
  }

  private enabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.ciRunTracking.enabled ?? false;
  }

  private liveGithubEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.ciRunTracking.liveGithubEnabled ?? true;
  }

  private githubActionsUrl(repoFullName: string): string {
    return `https://github.com/${repoFullName}/actions`;
  }
}
