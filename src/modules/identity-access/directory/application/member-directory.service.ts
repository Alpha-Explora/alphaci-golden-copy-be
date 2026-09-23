import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { MemberDirectorySource } from './member-directory.source';
import type {
  DirectoryCaller,
  DirectoryDescription,
  DirectoryEntry,
  DirectoryListing,
  DirectoryPerson,
  DirectoryQuery,
} from '../domain/directory.types';
import {
  DirectoryAccountsRepository,
  type DirectoryAccount,
} from '../infrastructure/directory-accounts.repository';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Answers "who can join a workspace on this deployment" the same way for
 * every caller: the member picker, the add-member check, and any client
 * system reading GET /api/v1/directory/members. A person is eligible when the
 * source lists them and they have an active AlphaCI account.
 *
 * An unreadable source is an error, never an empty directory: a silent empty
 * list is how the picker came to show nothing on every deployment without
 * GITHUB_INTERNAL_ORG.
 */
@Injectable()
export class MemberDirectoryService {
  constructor(
    private readonly source: MemberDirectorySource,
    private readonly accounts: DirectoryAccountsRepository,
  ) {}

  describe(): DirectoryDescription {
    return this.source.describe();
  }

  /**
   * For callers with no other authorization: the directory is readable by the
   * people in it, and by nobody else.
   */
  async listForCaller(
    caller: DirectoryCaller,
    query: DirectoryQuery,
  ): Promise<DirectoryListing> {
    const people = await this.readPeople(caller);
    const self = await this.accounts.findActiveById(caller.userId);
    if (
      !self ||
      !people.some((person) => sameLogin(person.login, self.login))
    ) {
      throw new ForbiddenException(
        "Only members of this deployment's member directory can read it.",
      );
    }
    return {
      ...this.source.describe(),
      members: await this.match(people, query, null),
    };
  }

  /**
   * For a caller its own context has already authorized, such as a workspace
   * lead. Leaves out people already active in `workspaceId`.
   */
  async listEligible(
    caller: DirectoryCaller,
    query: DirectoryQuery & { workspaceId: string },
  ): Promise<DirectoryEntry[]> {
    const people = await this.readPeople(caller);
    return this.match(people, query, query.workspaceId);
  }

  /** The account behind `userId`, provided the directory lists its owner. */
  async assertEligible(
    caller: DirectoryCaller,
    userId: string,
  ): Promise<{ id: string; login: string }> {
    const account = await this.accounts.findActiveById(userId);
    if (!account) {
      throw new NotFoundException('User not found');
    }
    const people = await this.readPeople(caller);
    if (!people.some((person) => sameLogin(person.login, account.login))) {
      throw new NotFoundException(this.notListedMessage(account.login));
    }
    return account;
  }

  private async readPeople(
    caller: DirectoryCaller,
  ): Promise<DirectoryPerson[]> {
    const read = await this.source.read(caller);
    if (read.kind === 'unavailable') {
      throw new ServiceUnavailableException(read.reason);
    }
    return read.people;
  }

  private async match(
    people: DirectoryPerson[],
    query: DirectoryQuery,
    workspaceId: string | null,
  ): Promise<DirectoryEntry[]> {
    const unique = new Map(
      people.map((person) => [person.login.toLowerCase(), person]),
    );
    const accounts = await this.accounts.findByLogins(
      [...unique.values()].map((person) => person.login),
      workspaceId,
    );
    const byLogin = new Map(
      accounts.map((account) => [account.login.toLowerCase(), account]),
    );
    const term = (query.search ?? '').trim().toLowerCase();

    return [...unique.values()]
      .filter(
        (person) => !byLogin.get(person.login.toLowerCase())?.isActiveMember,
      )
      .map((person) => toEntry(person, byLogin.get(person.login.toLowerCase())))
      .filter((entry) => matchesTerm(entry, term))
      .sort(
        (a, b) =>
          Number(b.hasAccount) - Number(a.hasAccount) ||
          a.login.localeCompare(b.login),
      )
      .slice(0, clampLimit(query.limit));
  }

  private notListedMessage(login: string): string {
    const { organization } = this.source.describe();
    return organization
      ? `${login} is not a member of the ${organization} GitHub organization.`
      : `${login} is not in this deployment's member directory.`;
  }
}

function toEntry(
  person: DirectoryPerson,
  account: DirectoryAccount | undefined,
): DirectoryEntry {
  return {
    id: account?.id ?? null,
    login: person.login,
    name: account?.name ?? person.login,
    email: account?.email ?? null,
    avatarUrl: account?.avatarUrl ?? person.avatarUrl,
    hasAccount: account !== undefined,
  };
}

function matchesTerm(entry: DirectoryEntry, term: string): boolean {
  if (!term) return true;
  return [entry.login, entry.name, entry.email].some((value) =>
    (value ?? '').toLowerCase().includes(term),
  );
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}
