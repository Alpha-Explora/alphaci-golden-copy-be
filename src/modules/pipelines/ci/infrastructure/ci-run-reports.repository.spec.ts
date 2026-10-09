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
