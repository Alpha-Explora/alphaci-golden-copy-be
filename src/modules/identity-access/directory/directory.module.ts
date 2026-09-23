import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type { AppConfig } from '#kernel/config/app.config';
import { DatabaseModule } from '#kernel/db/database.module';
import { AuthIdentityModule } from '#modules/identity-access/auth/auth-identity.module.js';
import { GithubModule } from '#modules/pipelines/github/github.module.js';

import { DirectoryController } from './api/directory.controller';
import { MemberDirectoryService } from './application/member-directory.service';
import { MemberDirectorySource } from './application/member-directory.source';
import { AccountsDirectorySource } from './infrastructure/accounts.directory-source';
import { DirectoryAccountsRepository } from './infrastructure/directory-accounts.repository';
import { GithubOrgDirectorySource } from './infrastructure/github-org.directory-source';

@Module({
  imports: [
    DatabaseModule,
    AuthIdentityModule, // SESSION_USER_LOOKUP for SessionAuthGuard
    GithubModule, // GITHUB_ORGANIZATION_PORT for the github_org source
  ],
  controllers: [DirectoryController],
  providers: [
    SessionAuthGuard,
    DirectoryAccountsRepository,
    GithubOrgDirectorySource,
    AccountsDirectorySource,
    {
      // One source per deployment, chosen by MEMBER_DIRECTORY_SOURCE. A new
      // kind of directory is one more subclass and one more branch here.
      provide: MemberDirectorySource,
      useFactory: (
        configService: ConfigService,
        githubOrg: GithubOrgDirectorySource,
        accounts: AccountsDirectorySource,
      ) =>
        configService.getOrThrow<AppConfig>('app').directory.source ===
        'accounts'
          ? accounts
          : githubOrg,
      inject: [
        ConfigService,
        GithubOrgDirectorySource,
        AccountsDirectorySource,
      ],
    },
    MemberDirectoryService,
  ],
  exports: [MemberDirectoryService],
})
export class DirectoryModule {}
