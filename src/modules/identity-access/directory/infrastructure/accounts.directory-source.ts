import { Injectable } from '@nestjs/common';

import { MemberDirectorySource } from '../application/member-directory.source';
import type {
  DirectoryDescription,
  DirectoryRead,
} from '../domain/directory.types';
import { DirectoryAccountsRepository } from './directory-accounts.repository';

/**
 * The directory is everyone with an active account on this deployment. For
 * an installation with no GitHub organization, where sign-in itself decides
 * who belongs (an on-prem deployment behind its own identity provider).
 * Choose it only where that holds: on a shared deployment it would let a lead
 * add any account.
 */
@Injectable()
export class AccountsDirectorySource extends MemberDirectorySource {
  constructor(private readonly accounts: DirectoryAccountsRepository) {
    super();
  }

  describe(): DirectoryDescription {
    return { source: 'accounts', organization: null };
  }

  async read(): Promise<DirectoryRead> {
    return { kind: 'ok', people: await this.accounts.listActivePeople() };
  }
}
