import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { UsersRepository } from './users.repository.js';
import { DatabaseService } from '#kernel/db/database.service.js';

const fakeRow = {
  id: 'user-uuid-1',
  login: 'testuser',
  display_name: 'Test User',
  email: 'test@example.com',
  avatar_url: 'https://example.com/avatar.png',
  onboarding_completed_at: null as string | null,
};

const makeDatabaseService = (row = fakeRow) =>
  ({
    query: jest.fn().mockResolvedValue({ rows: [row] }),
  }) as unknown as DatabaseService;

describe('UsersRepository', () => {
  let repo: UsersRepository;
  let db: DatabaseService;

  beforeEach(async () => {
    db = makeDatabaseService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersRepository, { provide: DatabaseService, useValue: db }],
    }).compile();

    repo = module.get(UsersRepository);
  });

  it('should be defined', () => {
    expect(repo).toBeDefined();
  });

  describe('upsertGitHubUser', () => {
    it('returns a mapped SessionUser', async () => {
      const result = await repo.upsertGitHubUser({
        githubUserId: 'gh-123',
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
        isInternal: false,
      });

      expect(result).toMatchObject({
        id: 'user-uuid-1',
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
      });
    });

    it('throws when upsert returns no row', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await expect(
        repo.upsertGitHubUser({
          githubUserId: 'gh-456',
          login: 'norow',
          isInternal: false,
        }),
      ).rejects.toThrow('Upsert returned no row');
    });

    it('passes null through to preserve is_internal on the sold platform', async () => {
      await repo.upsertGitHubUser({
        githubUserId: 'gh-preserve',
        login: 'employee',
        isInternal: null,
      });

      const [sql, params] = (db.query as jest.Mock).mock.calls[0] as [
        string,
        unknown[],
      ];
      // On UPDATE, COALESCE keeps the existing flag when the parameter is null.
      expect(sql).toContain('COALESCE($6::boolean, app_users.is_internal)');
      expect(params[5]).toBeNull();
    });

    it('normalizes login with special characters', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ ...fakeRow, login: 'user-name' }],
      });

      const result = await repo.upsertGitHubUser({
        githubUserId: 'gh-789',
        login: 'User Name!',
        isInternal: false,
      });

      expect(result.login).toBe('user-name');
    });
  });

  describe('upsertGoogleUser', () => {
    it('returns a mapped SessionUser', async () => {
      const result = await repo.upsertGoogleUser({
        googleUserId: 'google-123',
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
      });

      expect(result.id).toBe('user-uuid-1');
      expect(result.login).toBe('testuser');
    });

    it('throws when upsert returns no row', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      await expect(
        repo.upsertGoogleUser({ googleUserId: 'g-456', login: 'norow' }),
      ).rejects.toThrow('Upsert returned no row');
    });
  });

  describe('findById', () => {
    it('returns a SessionUser when found', async () => {
      const result = await repo.findById('user-uuid-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('user-uuid-1');
    });

    it('returns null when not found', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      const result = await repo.findById('missing-id');
      expect(result).toBeNull();
    });

    it('omits email and avatarUrl when null in DB', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ ...fakeRow, email: null, avatar_url: null }],
      });

      const result = await repo.findById('user-uuid-1');
      expect(result).not.toBeNull();
      expect('email' in result!).toBe(false);
      expect('avatarUrl' in result!).toBe(false);
    });
  });

  describe('archiveById', () => {
    it('executes UPDATE with archived_at = NOW() and does not throw', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      await expect(repo.archiveById('user-uuid-1')).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('archived_at = NOW()'),
        ['user-uuid-1'],
      );
    });
  });

  describe('findByGithubUserIdIncludingArchived', () => {
    it('returns null when no row found', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      const result = await repo.findByGithubUserIdIncludingArchived('gh-999');
      expect(result).toBeNull();
    });

    it('returns an ArchivedUserLookup with archivedAt null for active rows', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: 'user-uuid-1',
            login: 'testuser',
            archived_at: null,
            github_user_id: 'gh-123',
          },
        ],
      });
      const result = await repo.findByGithubUserIdIncludingArchived('gh-123');
      expect(result).toMatchObject({
        id: 'user-uuid-1',
        login: 'testuser',
        archivedAt: null,
        githubUserId: 'gh-123',
      });
    });

    it('returns an ArchivedUserLookup with archivedAt set for archived rows', async () => {
      const archivedAt = '2026-05-01T00:00:00Z';
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: 'user-uuid-1',
            login: 'testuser',
            archived_at: archivedAt,
            github_user_id: 'gh-123',
          },
        ],
      });
      const result = await repo.findByGithubUserIdIncludingArchived('gh-123');
      expect(result?.archivedAt).toBe(archivedAt);
    });
  });

  describe('restoreByGithubUserId', () => {
    it('returns a SessionUser when restore succeeds', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ ...fakeRow }],
      });
      const result = await repo.restoreByGithubUserId('gh-123', false);
      expect(result.id).toBe('user-uuid-1');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('archived_at   = NULL'),
        ['gh-123', false],
      );
    });

    it('throws when no row is returned', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      await expect(
        repo.restoreByGithubUserId('gh-missing', false),
      ).rejects.toThrow('Restore found no matching archived row');
    });
  });

  describe('hardDeleteByGithubUserId', () => {
    it('executes DELETE by github_user_id', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      await expect(
        repo.hardDeleteByGithubUserId('gh-123'),
      ).resolves.toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'DELETE FROM app_users WHERE github_user_id = $1',
        ),
        ['gh-123'],
      );
    });
  });

  describe('purgeExpiredArchived', () => {
    it('returns the count from the DB function', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ count: '7' }],
      });
      const count = await repo.purgeExpiredArchived(30);
      expect(count).toBe(7);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('purge_expired_archived_accounts($1)'),
        [30],
      );
    });

    it('returns 0 when the DB function returns no rows', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
      const count = await repo.purgeExpiredArchived(30);
      expect(count).toBe(0);
    });
  });
});
