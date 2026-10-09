import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseService } from '#kernel/db/database.service';
import { CiRunReportsRepository } from './ci-run-reports.repository';

describe('CiRunReportsRepository.findByRepoBranchSha', () => {
  const rows = [{ id: 'row-1' }];
  let query: jest.Mock;
  let repository: CiRunReportsRepository;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows });
    repository = new CiRunReportsRepository({
      query,
    } as unknown as DatabaseService);
  });

  it('reads one execution by repository, branch and commit, as bound parameters', async () => {
    const result = await repository.findByRepoBranchSha(
      'acme/orders-api',
      'uat',
      'a1b2c3d4e5f6',
    );

    expect(result).toBe(rows);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['acme/orders-api', 'uat', 'a1b2c3d4e5f6']);
    expect(sql).toContain('repo_full_name = $1');
    expect(sql).toContain('branch = $2');
    expect(sql).toContain('commit_sha = $3');
  });

  it('keys on the branch as well as the commit, because a promoted commit keeps its SHA', async () => {
    await repository.findByRepoBranchSha('acme/orders-api', 'main', 'abc1234');

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/branch\s*=\s*\$2/);
  });

  it('returns the most recent attempt of a stage first', async () => {
    await repository.findByRepoBranchSha('acme/orders-api', 'uat', 'abc1234');

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY run_id DESC, stage ASC/);
  });

  it('never interpolates a value into the SQL', async () => {
    await repository.findByRepoBranchSha(
      "x'; DROP TABLE workflow.ci_run_reports; --",
      'uat',
      'abc1234',
    );

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('DROP TABLE');
  });
});

describe('CiRunReportsRepository.latestStageReports: per-test detail', () => {
  const REAL_CASES = JSON.parse(
    readFileSync(
      join(__dirname, '../application/__fixtures__/real-playwright-cases.json'),
      'utf8',
    ),
  ) as unknown[];

  function rowWith(cases: unknown) {
    return {
      stage: 'verify',
      status: 'failure',
      run_id: '77',
      repo_full_name: 'acme/web',
      updated_at: '2026-10-09T13:00:00.000Z',
      results: {
        tests: { total: 6, passed: 5, failed: 1, failures: [], cases },
      },
    };
  }

  async function read(cases: unknown) {
    const query = jest.fn().mockResolvedValue({ rows: [rowWith(cases)] });
    const repository = new CiRunReportsRepository({
      query,
    } as unknown as DatabaseService);
    const [result] = await repository.latestStageReports({
      repoFullName: 'acme/web',
      branch: 'uat',
      commitSha: 'abc',
      stages: ['verify'],
    });
    return result?.tests;
  }

  it('reads back the real records a Playwright run stored', async () => {
    const tests = await read(REAL_CASES);
    expect(tests?.cases).toHaveLength(6);
    const failed = tests?.cases?.[0];
    expect(failed).toMatchObject({
      status: 'failed',
      file: 'tests/e2e/a11y.e2e-spec.ts',
      project: 'chromium',
      retries: 1,
    });
    expect(failed?.description).toContain('Runs the axe accessibility checker');
    expect(failed?.steps?.find((step) => step.failed)?.title).toBe(
      'Check for critical or serious violations',
    );
    expect(failed?.error?.message).toContain(
      'select-name (critical): Select element must have an accessible name',
    );
  });

  it('drops a malformed entry instead of the whole list', async () => {
    const tests = await read([
      { title: 'ok', status: 'passed', durationMs: 12 },
      { title: 'no status' },
      { status: 'failed' },
      'text',
      {
        title: 'bad fields',
        status: 'failed',
        line: -1,
        notes: [{ type: 'x' }],
        error: { location: 'a:1' },
      },
    ]);
    expect(tests?.cases).toEqual([
      { title: 'ok', status: 'passed', durationMs: 12 },
      { title: 'bad fields', status: 'failed' },
    ]);
  });

  it('leaves cases out when a pipeline did not send them', async () => {
    const tests = await read(undefined);
    expect(tests).not.toHaveProperty('cases');
  });
});
