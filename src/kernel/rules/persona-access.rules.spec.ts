import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  canBeAssignedRepository,
  canCreatePullRequest,
  canManageEnvVars,
  canManageProjectLifecycle,
  canMergeViaWorkspace,
  selfServicePullRequestBase,
  visibleBranchesFor,
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

describe('canBeAssignedRepository', () => {
  it('allows the Developer persona only', () => {
    expect(ALL_ROLES.filter((r) => canBeAssignedRepository(r))).toEqual([
      'member',
    ]);
  });
});

describe('selfServicePullRequestBase', () => {
  it('prefers dev, then uat, and never main', () => {
    expect(selfServicePullRequestBase(['main', 'uat', 'dev'])).toBe('dev');
    expect(selfServicePullRequestBase(['main', 'uat'])).toBe('uat');
    expect(selfServicePullRequestBase(['main'])).toBeNull();
    expect(selfServicePullRequestBase([])).toBeNull();
  });
});

describe('visibleBranchesFor', () => {
  const b = (name: string) => ({ name });
  const all = [
    b('dev'),
    b('uat'),
    b('main'),
    b('feature/Alice-login'),
    b('feature/bob-x'),
    b('hotfix/z'),
    b('spike'),
  ];
  const names = (list: { name: string }[]) => list.map((x) => x.name);

  it.each(['admin', 'lead'] as const)('shows %s every branch', (role) => {
    expect(names(visibleBranchesFor(role, 'alice', all, null))).toEqual(
      names(all),
    );
  });

  it('shows qa only the pipeline rungs that exist', () => {
    expect(names(visibleBranchesFor('qa', 'alice', all, null))).toEqual([
      'dev',
      'uat',
      'main',
    ]);
    expect(
      names(visibleBranchesFor('qa', 'alice', [b('main'), b('spike')], null)),
    ).toEqual(['main']);
  });

  it('hides main from a member even when they authored its head commit', () => {
    const authors = new Map([['main', 'alice']]);
    expect(
      names(visibleBranchesFor('member', 'alice', all, authors)),
    ).not.toContain('main');
  });

  it('shows a member dev, uat and own feature branches, never main', () => {
    expect(names(visibleBranchesFor('member', 'alice', all, null))).toEqual([
      'dev',
      'uat',
      'feature/Alice-login',
    ]);
  });

  it('matches the login case-insensitively', () => {
    expect(names(visibleBranchesFor('member', 'ALICE', all, null))).toContain(
      'feature/Alice-login',
    );
    expect(
      names(visibleBranchesFor('member', 'alice', all, null)),
    ).not.toContain('feature/bob-x');
  });

  it('adds branches whose head commit author is the login', () => {
    const authors = new Map<string, string | null>([
      ['hotfix/z', 'Alice'],
      ['spike', 'bob'],
      ['feature/bob-x', null],
    ]);
    expect(names(visibleBranchesFor('member', 'alice', all, authors))).toEqual([
      'dev',
      'uat',
      'feature/Alice-login',
      'hotfix/z',
    ]);
  });

  it('falls back to name matching when author data is unavailable', () => {
    expect(
      names(visibleBranchesFor('member', 'alice', all, null)),
    ).not.toContain('hotfix/z');
  });

  it('gives a member without a login only dev and uat', () => {
    expect(names(visibleBranchesFor('member', null, all, null))).toEqual([
      'dev',
      'uat',
    ]);
  });

  it('tolerates missing rungs for a member', () => {
    expect(
      names(
        visibleBranchesFor('member', 'alice', [b('main'), b('spike')], null),
      ),
    ).toEqual([]);
  });

  it('fails closed to dev only for an unknown role', () => {
    expect(names(visibleBranchesFor('intern', 'alice', all, null))).toEqual([
      'dev',
    ]);
  });
});
