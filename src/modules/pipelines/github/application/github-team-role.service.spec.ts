import { ConfigService } from '@nestjs/config';

import type {
  AppConfig,
  GithubTeamRoleSyncMode,
} from '#kernel/config/app.config';
import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher';
import type {
  AppRole,
  AppRoleSource,
} from '#modules/identity-access/admin/infrastructure/platform-admins.repository';
import type { PlatformAdminPort } from '#kernel/ports/platform-admin.port';
import type { GithubOrganizationPort } from '#kernel/ports/github.port';
import type { GithubInstallationsRepository } from '../infrastructure/github-installations.repository';
import {
  GithubTeamRoleService,
  combineLowerTeamReads,
  deriveReconciledRole,
} from './github-team-role.service';

const LEAD_TEAM = 'team-lead';
const QA_TEAM = 'qa-team';
const DEV_TEAM = 'developers';
/** Distinct from the user token so a mock can answer differently per reader. */
const INSTALLATION_TOKEN = 'installation-token';

function makeConfigService(mode: GithubTeamRoleSyncMode): ConfigService {
  const config = {
    github: {
      enforcedOrg: 'Alpha-Explora',
      teamRoleSync: mode,
      leadTeamSlug: LEAD_TEAM,
      qaTeamSlug: QA_TEAM,
      developerTeamSlug: DEV_TEAM,
    },
  } as unknown as AppConfig;

  return {
    getOrThrow: () => config,
  } as unknown as ConfigService;
}

/**
 * `memberships` maps team slug -> true (member) / false (not) / null
 * (unreadable — the case that must never demote anyone).
 */
function makeGithubService(
  memberships: Record<string, boolean | null>,
  rosters: Record<string, string[]> = {},
  appMemberships?: Record<string, boolean | null>,
): {
  service: GithubOrganizationPort;
  getTeamMembership: jest.Mock;
  createInstallationAccessToken: jest.Mock;
} {
  // Answers depend on WHICH token is asking: `appMemberships` is what the App
  // installation can see, `memberships` is what the user's OAuth token can.
  // Defaulting to the same map matters — the webhook and sweep paths read as
  // the App by design, so a test that does not care about the distinction must
  // still see its own `memberships` through an installation token.
  const appAnswers = appMemberships ?? memberships;
  const getTeamMembership = jest.fn(
    (
      teamSlug: string,
      _login: string,
      token: string,
    ): Promise<boolean | null> =>
      Promise.resolve(
        token === INSTALLATION_TOKEN
          ? (appAnswers[teamSlug] ?? null)
          : (memberships[teamSlug] ?? null),
      ),
  );
  const createInstallationAccessToken = jest.fn(() =>
    Promise.resolve(INSTALLATION_TOKEN),
  );
  const service = {
    onTeamMembershipChanged: jest.fn(),
    getTeamMembership,
    getEnforcedOrg: jest.fn(() => 'Alpha-Explora'),
    createInstallationAccessToken,
    listTeamMembersWithToken: jest.fn((teamSlug: string) =>
      Promise.resolve(rosters[teamSlug] ?? []),
    ),
  } as unknown as GithubOrganizationPort;
  return { service, getTeamMembership, createInstallationAccessToken };
}

function makeRepository(
  current: { role: AppRole; source: AppRoleSource },
  syncedUsers: Array<{ id: string; login: string; appRole: AppRole }> = [],
): {
  repository: PlatformAdminPort;
  setAppRole: jest.Mock;
  setAppRoleSource: jest.Mock;
} {
  const setAppRole = jest.fn(() => Promise.resolve());
  const setAppRoleSource = jest.fn(() => Promise.resolve());
  const repository = {
    findAppRoleWithSource: jest.fn(() => Promise.resolve(current)),
    findUserIdByGithubLogin: jest.fn(() => Promise.resolve('user-1')),
    listGithubTeamSyncedUsers: jest.fn(() => Promise.resolve(syncedUsers)),
    setAppRole,
    setAppRoleSource,
  } as unknown as PlatformAdminPort;
  return { repository, setAppRole, setAppRoleSource };
}

function makeAudit(): AuditEventPublisher {
  return {
    recordProjectEvent: jest.fn(() => Promise.resolve()),
  } as unknown as AuditEventPublisher;
}

function makeInstallations(
  installationId: number | null = 42,
): GithubInstallationsRepository {
  return {
    findInstallationIdByAccountLogin: jest.fn(() =>
      Promise.resolve(installationId),
    ),
  } as unknown as GithubInstallationsRepository;
}

function build(options: {
  mode?: GithubTeamRoleSyncMode;
  memberships?: Record<string, boolean | null>;
  current?: { role: AppRole; source: AppRoleSource };
  rosters?: Record<string, string[]>;
  syncedUsers?: Array<{ id: string; login: string; appRole: AppRole }>;
  installationId?: number | null;
  appMemberships?: Record<string, boolean | null>;
}) {
  const {
    service: githubService,
    getTeamMembership,
    createInstallationAccessToken,
  } = makeGithubService(
    options.memberships ?? {},
    options.rosters ?? {},
    options.appMemberships,
  );
  const { repository, setAppRole, setAppRoleSource } = makeRepository(
    options.current ?? { role: 'member', source: 'github_team' },
    options.syncedUsers ?? [],
  );
  const service = new GithubTeamRoleService(
    makeConfigService(options.mode ?? 'enforce'),
    githubService,
    repository,
    makeAudit(),
    makeInstallations(
      options.installationId === undefined ? 42 : options.installationId,
    ),
  );
  return {
    service,
    setAppRole,
    setAppRoleSource,
    getTeamMembership,
    createInstallationAccessToken,
  };
}

describe('GithubTeamRoleService', () => {
  describe('resolveRoleFromTeams', () => {
    it('maps team-lead membership to lead', async () => {
      const { service } = build({ memberships: { [LEAD_TEAM]: true } });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'lead',
      );
    });

    it('maps developers membership to member', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: false, [QA_TEAM]: false, [DEV_TEAM]: true },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'member',
      );
    });

    it('falls to member when the user is in the org but neither team', async () => {
      const { service } = build({
        memberships: {
          [LEAD_TEAM]: false,
          [QA_TEAM]: false,
          [DEV_TEAM]: false,
        },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'member',
      );
    });

    it('returns null (unknown) when a check is unreadable and none matched', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: false },
      });
      await expect(
        service.resolveRoleFromTeams('ada', 'tok'),
      ).resolves.toBeNull();
    });

    it('short-circuits on a lead hit so a broken developers read cannot block promotion', async () => {
      const { service, getTeamMembership } = build({
        memberships: { [LEAD_TEAM]: true, [DEV_TEAM]: null },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'lead',
      );
      expect(getTeamMembership).toHaveBeenCalledTimes(1);
    });

    it('maps qa-team membership to qa', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: false, [QA_TEAM]: true, [DEV_TEAM]: false },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'qa',
      );
    });

    it('ranks qa above developers for a user on both teams', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: false, [QA_TEAM]: true, [DEV_TEAM]: true },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'qa',
      );
    });

    it('ranks lead above qa and never reads the lower teams', async () => {
      const { service, getTeamMembership } = build({
        memberships: { [LEAD_TEAM]: true, [QA_TEAM]: true },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'lead',
      );
      expect(getTeamMembership).toHaveBeenCalledTimes(1);
    });

    it('stays unknown when the qa read fails, even with a developers hit', async () => {
      // Resolving 'member' here would demote a real QA tester on one bad read.
      const { service } = build({
        memberships: { [LEAD_TEAM]: false, [QA_TEAM]: null, [DEV_TEAM]: true },
      });
      await expect(
        service.resolveRoleFromTeams('ada', 'tok'),
      ).resolves.toBeNull();
    });
  });

  describe('combineLowerTeamReads', () => {
    it.each([
      [false, true, null, 'qa'],
      [null, true, false, 'qa'],
      [false, null, true, null],
      [false, false, true, 'member'],
      [false, false, false, 'member'],
      [null, false, false, null],
      [false, false, null, null],
    ] as const)('lead=%s qa=%s dev=%s -> %s', (lead, qa, dev, expected) => {
      expect(combineLowerTeamReads(lead, qa, dev)).toBe(expected);
    });
  });

  describe('deriveReconciledRole', () => {
    const leads = new Set(['ada']);
    const qa = new Set(['quinn']);

    it('assigns qa from a known qa roster, lead still winning', () => {
      expect(
        deriveReconciledRole(
          { login: 'Quinn', appRole: 'member' },
          leads,
          qa,
          true,
        ),
      ).toBe('qa');
      expect(
        deriveReconciledRole(
          { login: 'ada', appRole: 'qa' },
          leads,
          new Set(['ada']),
          true,
        ),
      ).toBe('lead');
    });

    it('demotes a qa user who left a known qa roster', () => {
      expect(
        deriveReconciledRole({ login: 'bob', appRole: 'qa' }, leads, qa, true),
      ).toBe('member');
    });

    it('keeps existing qa users when the qa roster is unknown', () => {
      expect(
        deriveReconciledRole(
          { login: 'quinn', appRole: 'qa' },
          leads,
          new Set(),
          false,
        ),
      ).toBeNull();
      expect(
        deriveReconciledRole(
          { login: 'bob', appRole: 'member' },
          leads,
          new Set(),
          false,
        ),
      ).toBe('member');
    });

    it('never touches an admin', () => {
      expect(
        deriveReconciledRole(
          { login: 'ada', appRole: 'admin' },
          leads,
          qa,
          true,
        ),
      ).toBeNull();
    });
  });

  describe('syncRoleForUser safety rules', () => {
    it('does nothing unless the mode is enforce', async () => {
      for (const mode of ['off', 'seed'] as GithubTeamRoleSyncMode[]) {
        const { service, setAppRole } = build({
          mode,
          memberships: { [LEAD_TEAM]: true },
        });
        await expect(
          service.syncRoleForUser({
            userId: 'user-1',
            login: 'ada',
            token: 'tok',
            trigger: 'test',
          }),
        ).resolves.toEqual({ status: 'disabled' });
        expect(setAppRole).not.toHaveBeenCalled();
      }
    });

    it('never touches a user pinned to manual', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
        current: { role: 'member', source: 'manual' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'test',
        }),
      ).resolves.toEqual({ status: 'pinned', role: 'member' });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('leaves the role untouched when GitHub is unreadable', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: null },
        current: { role: 'lead', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'test',
        }),
      ).resolves.toEqual({ status: 'unknown' });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('never auto-downgrades an admin', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: false, [QA_TEAM]: false, [DEV_TEAM]: true },
        current: { role: 'admin', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'test',
        }),
      ).resolves.toEqual({ status: 'unchanged', role: 'admin' });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('promotes a developer added to team-lead', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
        current: { role: 'member', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'login',
        }),
      ).resolves.toEqual({ status: 'updated', from: 'member', to: 'lead' });
      expect(setAppRole).toHaveBeenCalledWith('user-1', 'lead', 'github_team');
    });

    it('demotes a lead removed from team-lead — the security-relevant direction', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: false, [QA_TEAM]: false, [DEV_TEAM]: true },
        current: { role: 'lead', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'webhook:membership',
        }),
      ).resolves.toEqual({ status: 'updated', from: 'lead', to: 'member' });
      expect(setAppRole).toHaveBeenCalledWith(
        'user-1',
        'member',
        'github_team',
      );
    });

    it('treats an org owner as admin without reading teams', async () => {
      const { service, setAppRole, getTeamMembership } = build({
        current: { role: 'member', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          isOrgOwner: true,
          trigger: 'login',
        }),
      ).resolves.toEqual({ status: 'updated', from: 'member', to: 'admin' });
      expect(getTeamMembership).not.toHaveBeenCalled();
      expect(setAppRole).toHaveBeenCalledWith('user-1', 'admin', 'github_team');
    });

    it('writes nothing when the derived role already matches', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
        current: { role: 'lead', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'login',
        }),
      ).resolves.toEqual({ status: 'unchanged', role: 'lead' });
      expect(setAppRole).not.toHaveBeenCalled();
    });
  });

  describe('resolveSeedRole', () => {
    it('returns null when sync is off so the caller keeps legacy seeding', async () => {
      const { service } = build({
        mode: 'off',
        memberships: { [LEAD_TEAM]: true },
      });
      await expect(
        service.resolveSeedRole('ada', 'tok', false),
      ).resolves.toBeNull();
    });

    it('seeds lead from team membership under seed mode', async () => {
      const { service } = build({
        mode: 'seed',
        memberships: { [LEAD_TEAM]: true },
      });
      await expect(service.resolveSeedRole('ada', 'tok', false)).resolves.toBe(
        'lead',
      );
    });

    it('prefers org ownership over team membership', async () => {
      const { service } = build({
        mode: 'enforce',
        memberships: { [DEV_TEAM]: true },
      });
      await expect(service.resolveSeedRole('ada', 'tok', true)).resolves.toBe(
        'admin',
      );
    });

    /*
     * The regression these four cover: a first login is the ONE path with no
     * prior role to fall back on, so its caller converts null into 'member'
     * and stamps it app_role_source='github_team'. A lead whose own token
     * cannot read the org teams (no read:org scope, or OAuth App access
     * restrictions) was seeded as a Member and had no in-app way back.
     */
    it('asks the App when the user token cannot read the teams', async () => {
      const { service, createInstallationAccessToken } = build({
        mode: 'enforce',
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: null },
        appMemberships: { [LEAD_TEAM]: true },
      });
      await expect(service.resolveSeedRole('ada', 'tok', false)).resolves.toBe(
        'lead',
      );
      expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
    });

    it('does not consult the App when the user token already answered', async () => {
      const { service, createInstallationAccessToken } = build({
        mode: 'enforce',
        memberships: { [QA_TEAM]: false, [DEV_TEAM]: true },
        appMemberships: { [LEAD_TEAM]: true },
      });
      await expect(service.resolveSeedRole('ada', 'tok', false)).resolves.toBe(
        'member',
      );
      expect(createInstallationAccessToken).not.toHaveBeenCalled();
    });

    it('stays null when neither reader can see the teams', async () => {
      const { service } = build({
        mode: 'enforce',
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: null },
      });
      await expect(
        service.resolveSeedRole('ada', 'tok', false),
      ).resolves.toBeNull();
    });

    it('stays null when the org has no App installation', async () => {
      const { service, createInstallationAccessToken } = build({
        mode: 'enforce',
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: null },
        appMemberships: { [LEAD_TEAM]: true },
        installationId: null,
      });
      await expect(
        service.resolveSeedRole('ada', 'tok', false),
      ).resolves.toBeNull();
      expect(createInstallationAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('reconcileAll (Phase 4b sweep)', () => {
    const LEADS = { [LEAD_TEAM]: ['ada'], [DEV_TEAM]: ['bob'] };

    it('does nothing unless the mode is enforce', async () => {
      const { service, setAppRole } = build({ mode: 'seed', rosters: LEADS });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'disabled',
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('bails out when no org installation exists', async () => {
      const { service, setAppRole } = build({
        rosters: LEADS,
        installationId: null,
      });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'unreadable',
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('refuses to act when both rosters come back empty', async () => {
      // An empty roster is indistinguishable from an unreadable one, and
      // acting on it would demote every lead in the org in a single pass.
      const { service, setAppRole } = build({
        rosters: {},
        syncedUsers: [{ id: 'u1', login: 'ada', appRole: 'lead' }],
      });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'unreadable',
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('promotes and demotes to match the rosters', async () => {
      const { service, setAppRole } = build({
        rosters: LEADS,
        syncedUsers: [
          { id: 'u1', login: 'ada', appRole: 'member' }, // in team-lead → promote
          { id: 'u2', login: 'bob', appRole: 'lead' }, // not in team-lead → demote
          { id: 'u3', login: 'cleo', appRole: 'member' }, // already correct
        ],
      });

      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'completed',
        checked: 3,
        updated: 2,
      });
      expect(setAppRole).toHaveBeenCalledWith('u1', 'lead', 'github_team');
      expect(setAppRole).toHaveBeenCalledWith('u2', 'member', 'github_team');
      expect(setAppRole).toHaveBeenCalledTimes(2);
    });

    it('never auto-downgrades an admin during the sweep', async () => {
      const { service, setAppRole } = build({
        rosters: LEADS,
        syncedUsers: [{ id: 'u1', login: 'zed', appRole: 'admin' }],
      });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'completed',
        checked: 1,
        updated: 0,
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('promotes qa-team members to qa during the sweep', async () => {
      const { service, setAppRole } = build({
        rosters: { ...LEADS, [QA_TEAM]: ['quinn'] },
        syncedUsers: [
          { id: 'u1', login: 'quinn', appRole: 'member' },
          { id: 'u2', login: 'bob', appRole: 'qa' },
        ],
      });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'completed',
        checked: 2,
        updated: 2,
      });
      expect(setAppRole).toHaveBeenCalledWith('u1', 'qa', 'github_team');
      expect(setAppRole).toHaveBeenCalledWith('u2', 'member', 'github_team');
    });

    it('leaves qa users alone when the qa roster comes back empty', async () => {
      // Empty is indistinguishable from unreadable: it must not demote QA.
      const { service, setAppRole } = build({
        rosters: LEADS,
        syncedUsers: [{ id: 'u1', login: 'quinn', appRole: 'qa' }],
      });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'completed',
        checked: 1,
        updated: 0,
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('matches logins case-insensitively', async () => {
      const { service, setAppRole } = build({
        rosters: { [LEAD_TEAM]: ['Ada'], [DEV_TEAM]: ['bob'] },
        syncedUsers: [{ id: 'u1', login: 'ada', appRole: 'member' }],
      });
      await expect(service.reconcileAll()).resolves.toEqual({
        status: 'completed',
        checked: 1,
        updated: 1,
      });
      expect(setAppRole).toHaveBeenCalledWith('u1', 'lead', 'github_team');
    });
  });

  describe('membership webhook filtering', () => {
    it('ignores teams that are not one of the three configured role teams', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
      });
      // A per-repository access team (`{repo}-developers`) must never re-role
      // anyone — granting repo access is not a promotion.
      await service.syncFromMembershipEvent({
        login: 'ada',
        installationId: 1,
      });
      expect(setAppRole).toHaveBeenCalled();
      setAppRole.mockClear();

      // Emulate the listener's slug filter via the public event contract.
      const listener = (
        service as unknown as {
          handleMembershipEvent: (event: {
            action: string;
            login: string;
            teamSlug: string;
            installationId: number;
          }) => Promise<void>;
        }
      ).handleMembershipEvent.bind(service);

      await listener({
        action: 'added',
        login: 'ada',
        teamSlug: 'some-repo-developers',
        installationId: 1,
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });
  });
});
