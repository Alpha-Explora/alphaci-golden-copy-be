import { DatabaseService } from '#kernel/db/database.service.js';
import { EduAuthRepository } from './edu-auth.repository.js';

const accountRow = {
  user_id: 'user-1',
  email: 'teacher@school.edu',
  full_name: 'Teacher User',
  role: 'TEACHER' as const,
  status: 'ACTIVE' as const,
  home_lab_id: 'lab-1',
  github_user_id: null,
  github_login: null,
  github_avatar_url: null,
  github_profile_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
  supabase_user_id: 'supabase-user-1',
};

const labRow = {
  id: 'lab-1',
  name: 'Main Lab',
  github_org_name: 'main-lab',
};

describe('EduAuthRepository', () => {
  it('loads an EDU account through the explicit Supabase provider binding', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({ rows: [accountRow] }),
      withTransaction: jest.fn(),
    } as unknown as DatabaseService;
    const repository = new EduAuthRepository(databaseService);

    await expect(
      repository.findBySupabaseUserId('supabase-user-1'),
    ).resolves.toMatchObject({
      userId: 'user-1',
      supabaseUserId: 'supabase-user-1',
      role: 'TEACHER',
    });
    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining("si.provider = 'supabase'"),
      ['supabase-user-1'],
    );
  });

  it('returns only active labs allowed by the EDU role query', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({ rows: [labRow] }),
      withTransaction: jest.fn(),
    } as unknown as DatabaseService;
    const repository = new EduAuthRepository(databaseService);

    await expect(
      repository.listAccessibleLabs('user-1', 'TEACHER'),
    ).resolves.toEqual([
      { id: 'lab-1', name: 'Main Lab', githubOrgName: 'main-lab' },
    ]);
    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE l.active = true'),
      ['user-1', 'TEACHER'],
    );
  });
});
