import type { DatabaseService } from '../../kernel/db/database.service.js';
import { GithubInstallationsRepository } from './github-installations.repository.js';

const makeDatabaseService = (rows: unknown[] = []) =>
  ({
    query: jest.fn().mockResolvedValue({ rows }),
  }) as unknown as DatabaseService;

describe('GithubInstallationsRepository', () => {
  it('upserts installation accounts into the github_app schema', async () => {
    const db = makeDatabaseService([
      {
        installation_id: 12345,
        user_id: '11111111-1111-1111-1111-111111111111',
        account_login: 'cicd-external-project',
        account_id: 98765,
        account_type: 'Organization',
        repository_selection: 'selected',
        repos_linked: 2,
        created_at: '2026-06-09T00:00:00.000Z',
      },
    ]);
    const repo = new GithubInstallationsRepository(db);

    const result = await repo.upsert(
      '11111111-1111-1111-1111-111111111111',
      12345,
      'cicd-external-project',
      98765,
      'Organization',
      'selected',
      2,
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO github_app.github_installation_accounts',
      ),
      [
        12345,
        '11111111-1111-1111-1111-111111111111',
        'cicd-external-project',
        98765,
        'Organization',
        'selected',
        2,
      ],
    );
    expect(result).toEqual({
      installationId: 12345,
      userId: '11111111-1111-1111-1111-111111111111',
      accountLogin: 'cicd-external-project',
      accountId: 98765,
      accountType: 'Organization',
      repositorySelection: 'selected',
      reposLinked: 2,
    });
  });

  it('lists repos from github_app.github_installations', async () => {
    const db = makeDatabaseService([
      {
        installation_id: 12345,
        repo_full_name: 'cicd-external-project/orders-api',
      },
    ]);
    const repo = new GithubInstallationsRepository(db);

    const result = await repo.findReposByUserId(
      '11111111-1111-1111-1111-111111111111',
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM github_app.github_installations'),
      ['11111111-1111-1111-1111-111111111111'],
    );
    expect(result).toEqual([
      {
        installationId: 12345,
        repoFullName: 'cicd-external-project/orders-api',
      },
    ]);
  });

  it('replaces repo grants through github_app.github_installations', async () => {
    const db = makeDatabaseService();
    const repo = new GithubInstallationsRepository(db);

    await repo.replaceRepos(12345, [
      'cicd-external-project/api',
      'cicd-external-project/web',
    ]);

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM github_app.github_installations WHERE installation_id = $1;',
      [12345],
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO github_app.github_installations'),
      [12345, 'cicd-external-project/api', 'cicd-external-project/web'],
    );
  });
});
