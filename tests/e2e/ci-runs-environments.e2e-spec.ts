import {
  startApplication,
  type E2eApplication,
  type SignedInAgent,
} from './support/application';
import { required } from './support/database';

type RunsBody = {
  runs: Array<{
    repoFullName: string;
    overallStatus: string;
    stages: Array<{ stage: string; status: string }>;
  }>;
};

/**
 * The Runs view for a project with its own environments. Their pipelines end
 * at the package stage, so waiting for a verify report made every run of a
 * healthy pipeline show as failed. Failure modes: an environments run marked
 * failed because verify never reported; the same missing report no longer
 * failing a legacy pipeline, which does have a verify stage.
 */
describe('Runs for projects with environments', () => {
  let e2e: E2eApplication;
  let agent: SignedInAgent;
  let userId: string;

  beforeAll(async () => {
    e2e = await startApplication();
    ({ agent, userId } = await e2e.signIn());
  });

  afterAll(async () => {
    await e2e.close();
  });

  async function pipelineRun(repo: string, withEnvironments: boolean) {
    const [project] = await e2e.query<{ id: string }>(
      `INSERT INTO projects.provisioned_projects
         (user_id, repo_full_name, template_id, service_name, workflow_path, status)
       VALUES ($1, $2, 'node-api', 'api', '.github/workflows/ci.yml', 'provisioned')
       RETURNING id`,
      [userId, repo],
    );
    if (withEnvironments) {
      await e2e.query(
        `INSERT INTO projects.project_environments
           (project_id, slug, display_name, position, source_branch, role, auto_deploy)
         VALUES ($1, 'main', 'main', 0, 'main', 'production', true)`,
        [required(project).id],
      );
    }
    // Reported a day ago, so a stage that never arrives has stalled by now.
    for (const [index, stage] of ['access', 'quality', 'package'].entries()) {
      await e2e.query(
        `INSERT INTO workflow.ci_run_reports
           (user_id, repo_full_name, branch, commit_sha, run_id, stage, status, created_at, updated_at)
         VALUES ($1, $2, 'uat', $3, $4, $5, 'success',
                 now() - interval '1 day', now() - interval '1 day')`,
        [userId, repo, 'a'.repeat(40), 1000 + index, stage],
      );
    }
    const response = await agent
      .get('/api/v1/ci/runs')
      .query({ repoFullName: repo })
      .expect(200);
    return required((response.body as RunsBody).runs[0]);
  }

  it('shows a successful environments pipeline as successful, without a verify stage', async () => {
    const run = await pipelineRun('e2e-org/with-environments', true);
    expect(run.overallStatus).toBe('success');
    expect(run.stages.map(({ stage }) => stage)).toEqual([
      'access',
      'quality',
      'package',
    ]);
  });

  it('still fails a legacy pipeline whose verify report never arrived', async () => {
    const run = await pipelineRun('e2e-org/legacy', false);
    expect(run.overallStatus).toBe('failure');
    expect(run.stages.find(({ stage }) => stage === 'verify')?.status).toBe(
      'stalled',
    );
  });
});
