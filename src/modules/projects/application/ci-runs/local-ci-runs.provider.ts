import { Inject, Injectable, Optional } from '@nestjs/common';

import type {
  CiRunsProjectContext,
  CiRunsProvider,
  CiRunStage,
  ProjectCiRun,
} from './project-ci-runs.types';

export const LOCAL_CI_RUNS_OPTIONS = 'LOCAL_CI_RUNS_OPTIONS';

export interface LocalCiRunsProviderOptions {
  fixtureMode?: boolean;
}

@Injectable()
export class LocalCiRunsProvider implements CiRunsProvider {
  private readonly fixtureMode: boolean;

  constructor(
    @Optional()
    @Inject(LOCAL_CI_RUNS_OPTIONS)
    options: LocalCiRunsProviderOptions = {},
  ) {
    this.fixtureMode =
      options.fixtureMode ??
      process.env['CI_RUN_LOCAL_FIXTURES_ENABLED'] === 'true';
  }

  listRuns(context: CiRunsProjectContext): Promise<ProjectCiRun[]> {
    if (!this.fixtureMode) {
      return Promise.resolve([]);
    }

    const now = '2026-06-12T00:00:00.000Z';
    const runs: ProjectCiRun[] = context.workflowFiles.map((file) => {
      const stage = this.mapWorkflowNameToStage(file.name);
      return {
        id: `local-${context.projectId}-${stage}`,
        stage,
        workflowName: file.name,
        branch: 'test',
        commitSha: null,
        actor: 'alphaci-local',
        status: 'completed' as const,
        conclusion:
          stage === 'quality' ? ('failure' as const) : ('success' as const),
        createdAt: now,
        updatedAt: now,
        htmlUrl: this.githubWorkflowUrl(context.repoFullName, file.path),
        canRerun: false,
      };
    });
    return Promise.resolve(runs);
  }

  async getRun(
    context: CiRunsProjectContext,
    runId: string,
  ): Promise<ProjectCiRun | null> {
    const runs = await this.listRuns(context);
    return runs.find((run) => run.id === runId) ?? null;
  }

  mapWorkflowNameToStage(workflowName: string): CiRunStage {
    const normalized = workflowName.toLowerCase();
    if (normalized.includes('access gate')) return 'access_gate';
    if (normalized.includes('quality')) return 'quality';
    if (normalized.includes('package')) return 'package';
    if (normalized.includes('deploy render')) return 'deploy_render';
    if (normalized.includes('deploy vercel')) return 'deploy_vercel';
    return 'unknown';
  }

  private githubWorkflowUrl(
    repoFullName: string,
    workflowPath: string,
  ): string {
    const fileName = workflowPath.split('/').pop() ?? workflowPath;
    return `https://github.com/${repoFullName}/actions/workflows/${fileName}`;
  }
}
