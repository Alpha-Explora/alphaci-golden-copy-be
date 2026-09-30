import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  canCreatePullRequest,
  canManageEnvVars,
  canManageProjectLifecycle,
  canMergeViaWorkspace,
} from './persona-access.rules';

const ALL_ROLES: readonly PlatformAppRole[] = ['admin', 'lead', 'qa', 'member'];

describe('canMergeViaWorkspace', () => {
  it.each(ALL_ROLES)('refuses %s into the production branch, main', (role) => {
    expect(canMergeViaWorkspace(role, 'main')).toBe(false);
  });

  it.each(['admin', 'lead', 'member'] as const)(
    'allows %s to merge into a non-production branch',
    (role) => {
      expect(canMergeViaWorkspace(role, 'uat')).toBe(true);
      expect(canMergeViaWorkspace(role, 'dev')).toBe(true);
    },
  );

  it('refuses qa on any base, production or not', () => {
    expect(canMergeViaWorkspace('qa', 'uat')).toBe(false);
    expect(canMergeViaWorkspace('qa', 'dev')).toBe(false);
    expect(canMergeViaWorkspace('qa', 'main')).toBe(false);
  });
});

describe('canCreatePullRequest', () => {
  it.each(ALL_ROLES)(
    'refuses %s opening a pull request into the production branch, main',
    (role) => {
      expect(canCreatePullRequest(role, 'main')).toBe(false);
    },
  );

  it.each(['admin', 'lead', 'member'] as const)(
    'allows %s to open a pull request into a non-production branch',
    (role) => {
      expect(canCreatePullRequest(role, 'uat')).toBe(true);
      expect(canCreatePullRequest(role, 'dev')).toBe(true);
    },
  );

  it('refuses qa on any base, production or not', () => {
    expect(canCreatePullRequest('qa', 'uat')).toBe(false);
    expect(canCreatePullRequest('qa', 'dev')).toBe(false);
    expect(canCreatePullRequest('qa', 'main')).toBe(false);
  });
});

describe('canManageEnvVars', () => {
  it('allows admin and lead only', () => {
    expect(canManageEnvVars('admin')).toBe(true);
    expect(canManageEnvVars('lead')).toBe(true);
  });

  it('refuses qa and member', () => {
    expect(canManageEnvVars('qa')).toBe(false);
    expect(canManageEnvVars('member')).toBe(false);
  });
});

describe('canManageProjectLifecycle', () => {
  it('allows admin and lead only', () => {
    expect(canManageProjectLifecycle('admin')).toBe(true);
    expect(canManageProjectLifecycle('lead')).toBe(true);
  });

  it('refuses qa and member', () => {
    expect(canManageProjectLifecycle('qa')).toBe(false);
    expect(canManageProjectLifecycle('member')).toBe(false);
  });
});
