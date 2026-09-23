import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { DirectoryAccountsRepository } from '../infrastructure/directory-accounts.repository';
import type { DirectoryPerson, DirectoryRead } from '../domain/directory.types';
import { MemberDirectoryService } from './member-directory.service';
import { MemberDirectorySource } from './member-directory.source';

class FakeSource extends MemberDirectorySource {
  constructor(
    public result: DirectoryRead,
    private readonly organization: string | null = 'Alpha-Explora',
  ) {
    super();
  }

  describe() {
    return { source: 'github_org' as const, organization: this.organization };
  }

  read = jest.fn(() => Promise.resolve(this.result));
}

const people = (...logins: string[]): DirectoryPerson[] =>
  logins.map((login) => ({ login, avatarUrl: `https://gh/${login}` }));

const account = (
  id: string,
  login: string,
  extra: { isActiveMember?: boolean; name?: string; email?: string } = {},
) => ({
  id,
  login,
  name: extra.name ?? login,
  email: extra.email ?? null,
  avatarUrl: `https://app/${login}`,
  isActiveMember: extra.isActiveMember ?? false,
});

describe('MemberDirectoryService', () => {
  const caller = { userId: 'lloyd-id', githubToken: 'gho_lloyd' };
  let source: FakeSource;
  let accounts: jest.Mocked<DirectoryAccountsRepository>;
  let service: MemberDirectoryService;

  beforeEach(() => {
    source = new FakeSource({
      kind: 'ok',
      people: people('lloydlim1', 'bpramos-ae', 'not-signed-in'),
    });
    accounts = {
      findByLogins: jest
        .fn()
        .mockResolvedValue([
          account('lloyd-id', 'lloydlim1'),
          account('ramos-id', 'bpramos-ae', { name: 'B Ramos' }),
        ]),
      findActiveById: jest
        .fn()
        .mockResolvedValue({ id: 'lloyd-id', login: 'lloydlim1' }),
      listActivePeople: jest.fn(),
    } as unknown as jest.Mocked<DirectoryAccountsRepository>;
    service = new MemberDirectoryService(source, accounts);
  });

  describe('listEligible', () => {
    it('lists signed-in org members as addable, with no internal-flag requirement', async () => {
      const entries = await service.listEligible(caller, {
        workspaceId: 'group-1',
      });

      expect(entries).toEqual([
        {
          id: 'ramos-id',
          login: 'bpramos-ae',
          name: 'B Ramos',
          email: null,
          avatarUrl: 'https://app/bpramos-ae',
          hasAccount: true,
        },
        expect.objectContaining({ login: 'lloydlim1', hasAccount: true }),
        {
          id: null,
          login: 'not-signed-in',
          name: 'not-signed-in',
          email: null,
          avatarUrl: 'https://gh/not-signed-in',
          hasAccount: false,
        },
      ]);
      expect(accounts.findByLogins).toHaveBeenCalledWith(
        ['lloydlim1', 'bpramos-ae', 'not-signed-in'],
        'group-1',
      );
      expect(source.read).toHaveBeenCalledWith(caller);
    });

    it('leaves out people already active in the workspace', async () => {
      accounts.findByLogins.mockResolvedValue([
        account('lloyd-id', 'lloydlim1', { isActiveMember: true }),
        account('ramos-id', 'bpramos-ae'),
      ]);

      const entries = await service.listEligible(caller, {
        workspaceId: 'group-1',
      });

      expect(entries.map((entry) => entry.login)).toEqual([
        'bpramos-ae',
        'not-signed-in',
      ]);
    });

    it('narrows by login, name, or email, case-insensitively', async () => {
      accounts.findByLogins.mockResolvedValue([
        account('ramos-id', 'bpramos-ae', { email: 'b.ramos@example.com' }),
      ]);

      const byEmail = await service.listEligible(caller, {
        workspaceId: 'group-1',
        search: 'EXAMPLE.COM',
      });

      expect(byEmail.map((entry) => entry.login)).toEqual(['bpramos-ae']);
    });

    it('matches logins without regard to case and drops duplicates', async () => {
      source.result = {
        kind: 'ok',
        people: people('BPRAMOS-AE', 'bpramos-ae'),
      };

      const entries = await service.listEligible(caller, {
        workspaceId: 'group-1',
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ id: 'ramos-id', hasAccount: true });
    });

    it('caps the result at the requested limit', async () => {
      const entries = await service.listEligible(caller, {
        workspaceId: 'group-1',
        limit: 1,
      });

      expect(entries).toHaveLength(1);
    });

    it('reports an unreadable source as 503 with its reason, never as nobody', async () => {
      source.result = {
        kind: 'unavailable',
        reason: 'The Alpha-Explora GitHub organization could not be read.',
      };

      await expect(
        service.listEligible(caller, { workspaceId: 'group-1' }),
      ).rejects.toThrow(
        new ServiceUnavailableException(
          'The Alpha-Explora GitHub organization could not be read.',
        ),
      );
      expect(accounts.findByLogins).not.toHaveBeenCalled();
    });
  });

  describe('listForCaller (the public API)', () => {
    it('serves the directory to someone in it', async () => {
      const listing = await service.listForCaller(caller, {});

      expect(listing).toMatchObject({
        source: 'github_org',
        organization: 'Alpha-Explora',
      });
      expect(listing.members).toHaveLength(3);
      expect(accounts.findByLogins).toHaveBeenCalledWith(
        expect.any(Array),
        null,
      );
    });

    it('refuses someone outside the directory', async () => {
      accounts.findActiveById.mockResolvedValue({
        id: 'outsider-id',
        login: 'outsider',
      });

      await expect(service.listForCaller(caller, {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('assertEligible', () => {
    it('accepts an account whose owner the directory lists', async () => {
      accounts.findActiveById.mockResolvedValue({
        id: 'ramos-id',
        login: 'bpramos-ae',
      });

      await expect(service.assertEligible(caller, 'ramos-id')).resolves.toEqual(
        { id: 'ramos-id', login: 'bpramos-ae' },
      );
    });

    it('refuses an account outside the organization, naming it', async () => {
      accounts.findActiveById.mockResolvedValue({
        id: 'outsider-id',
        login: 'outsider',
      });

      await expect(
        service.assertEligible(caller, 'outsider-id'),
      ).rejects.toThrow(
        new NotFoundException(
          'outsider is not a member of the Alpha-Explora GitHub organization.',
        ),
      );
    });

    it('refuses an archived or unknown account before reading the source', async () => {
      accounts.findActiveById.mockResolvedValue(null);

      await expect(
        service.assertEligible(caller, 'gone-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(source.read).not.toHaveBeenCalled();
    });

    it('fails closed when the source cannot be read', async () => {
      accounts.findActiveById.mockResolvedValue({
        id: 'ramos-id',
        login: 'bpramos-ae',
      });
      source.result = { kind: 'unavailable', reason: 'unreadable' };

      await expect(
        service.assertEligible(caller, 'ramos-id'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
