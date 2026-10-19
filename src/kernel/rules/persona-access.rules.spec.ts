import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  canBeAssignedRepository,
  canCreatePullRequest,
  canCreateProjectFolder,
  canCreateRepository,
  canCreateWorkspaceBranch,
  canManageRequirements,
  repositoryCreateRequiresProject,
  repositoryCreateRequiresFeature,
  canManageEnvVars,
  canManageHosting,
  canManageProjectLifecycle,
  canMergeViaWorkspace,
  selfServicePullRequestBase,
  visibleBranchesFor,
} from './persona-access.rules';

const ALL_ROLES: readonly PlatformAppRole[] = ['admin', 'lead', 'qa', 'member'];

// [head, base] pairs; 'feature/x' stands for any non-pipeline branch.
const ROUTES: readonly (readonly [string, string])[] = [
  ['feature/x', 'dev'],
  ['feature/x', 'uat'],
  ['dev', 'uat'],
  ['uat', 'dev'],
  ['dev', 'main'],
  ['feature/x', 'main'],
  ['uat', 'main'],
];

const EXPECTED: Record<PlatformAppRole, readonly boolean[]> = {
  //      f>dev f>uat dev>uat uat>dev dev>main f>main uat>main
  admin: [true, true, true, true, false, false, false],
  lead: [true, true, true, true, false, false, false],
  member: [true, false, true, false, false, false, false],
  qa: [false, false, false, false, false, false, false],
};

describe.each([
  ['canMergeViaWorkspace', canMergeViaWorkspace],
  ['canCreatePullRequest', canCreatePullRequest],
])('%s', (_name, rule) => {
  describe.each(ALL_ROLES)('%s', (role) => {
    it.each(ROUTES.map((r, i) => [r[0], r[1], EXPECTED[role][i]] as const))(
      '%s -> %s is %s',
      (head, base, allowed) => {
        expect(rule(role, base, head)).toBe(allowed);
      },
    );
  });
});

describe.each([
  ['canManageEnvVars', canManageEnvVars],
  ['canManageHosting', canManageHosting],
])('%s', (_name, rule) => {
  it.each([
    ['admin', true],
    ['member', true],
    ['lead', false],
    ['qa', false],
  ] as const)('%s -> %s', (role, expected) => {
    expect(rule(role)).toBe(expected);
  });

  it.each([null, undefined])('refuses an unresolved role (%s)', (role) => {
    expect(rule(role)).toBe(false);
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
    expect(names(visibleBranchesFor(role, all))).toEqual(names(all));
  });

  it('shows qa only the pipeline rungs that exist', () => {
    expect(names(visibleBranchesFor('qa', all))).toEqual([
      'dev',
      'uat',
      'main',
    ]);
    expect(names(visibleBranchesFor('qa', [b('main'), b('spike')]))).toEqual([
      'main',
    ]);
  });

  it('shows Developers every branch for read-only browsing', () => {
    expect(names(visibleBranchesFor('member', all))).toEqual(names(all));
  });

  it('fails closed to dev only for an unknown role', () => {
    expect(names(visibleBranchesFor('intern', all))).toEqual(['dev']);
  });
});

describe('Project / repository create rules', () => {
  it.each([
    ['admin', true],
    ['lead', true],
    ['member', true],
    ['qa', false],
  ] as const)('canCreateWorkspaceBranch(%s) is %s', (role, expected) => {
    expect(canCreateWorkspaceBranch(role)).toBe(expected);
  });

  it.each([
    ['admin', true],
    ['lead', true],
    ['member', false],
    ['qa', false],
  ] as const)('canCreateProjectFolder(%s) is %s', (role, expected) => {
    expect(canCreateProjectFolder(role)).toBe(expected);
  });

  it.each([
    ['admin', true],
    ['lead', true],
    ['member', false],
    ['qa', false],
  ] as const)('canManageRequirements(%s) is %s', (role, expected) => {
    expect(canManageRequirements(role)).toBe(expected);
  });

  it.each([
    ['admin', true],
    ['lead', false],
    ['member', true],
    ['qa', false],
  ] as const)('canCreateRepository(%s) is %s', (role, expected) => {
    expect(canCreateRepository(role)).toBe(expected);
  });

  it.each([
    ['admin', false],
    ['lead', false],
    ['member', true],
    ['qa', false],
  ] as const)('repositoryCreateRequiresProject(%s) is %s', (role, expected) => {
    expect(repositoryCreateRequiresProject(role)).toBe(expected);
  });

  it.each([
    ['admin', false],
    ['lead', false],
    ['member', true],
    ['qa', false],
  ] as const)('repositoryCreateRequiresFeature(%s) is %s', (role, expected) => {
    expect(repositoryCreateRequiresFeature(role)).toBe(expected);
  });

  it('repositoryCreateRequiresFeature fails closed for an unresolved role', () => {
    expect(repositoryCreateRequiresFeature('viewer' as PlatformAppRole)).toBe(
      false,
    );
    expect(
      repositoryCreateRequiresFeature(undefined as unknown as PlatformAppRole),
    ).toBe(false);
  });

  it('fails closed for an unknown role', () => {
    const unknown = 'viewer' as PlatformAppRole;
    expect(canCreateProjectFolder(unknown)).toBe(false);
    expect(canCreateRepository(unknown)).toBe(false);
    expect(canManageRequirements(unknown)).toBe(false);
  });
});
