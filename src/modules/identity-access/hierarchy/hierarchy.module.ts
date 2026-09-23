import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type { AppConfig } from '#kernel/config/app.config';
import { AdminModule } from '#modules/identity-access/admin/admin.module.js';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { AuthIdentityModule } from '#modules/identity-access/auth/auth-identity.module.js';
import { DirectoryModule } from '#modules/identity-access/directory/directory.module.js';
import { GithubModule } from '#modules/pipelines/github/github.module.js';

import { AssignmentsController } from './api/assignments.controller';
import { AssignmentsRepository } from './infrastructure/assignments.repository';
import { AssignmentsService } from './application/assignments.service';
import { RepoConfigBrokerController } from './api/repo-config-broker.controller';
import { GITHUB_SECRETS_BROKER } from './application/github-secrets.broker';
import { RepoConfigBrokerService } from './application/repo-config-broker.service';
import { RepoConfigurationChangesRepository } from './infrastructure/repo-configuration-changes.repository';
import { GithubSecretsProvider } from './infrastructure/config-broker-providers/github-secrets.provider';
import { DeliveryProjectsController } from './api/delivery-projects.controller';
import { DeliveryProjectsRepository } from './infrastructure/delivery-projects.repository';
import { DeliveryProjectsService } from './application/delivery-projects.service';
import { GithubSyncOutboxHandler } from './application/github-sync-outbox.handler';
import { GithubAccessSyncRepository } from './infrastructure/github-access-sync.repository';
import { GithubSyncService } from './application/github-sync.service';
import { GithubTeamAccessProvider } from './application/github-team-access.provider';
import { GithubTeamAccessLiveProvider } from './infrastructure/github-sync/providers/github-team-access.live';
import { GithubTeamAccessStubProvider } from './infrastructure/github-sync/providers/github-team-access.stub';
import { GroupActivityRepository } from './infrastructure/group-activity.repository';
import { GroupActivityService } from './application/group-activity.service';
import { GroupMembersService } from './application/group-members.service';
import { GroupsController } from './api/groups.controller';
import { GroupsRepository } from './infrastructure/groups.repository';
import { GroupsService } from './application/groups.service';
import { HierarchyAccessService } from './application/hierarchy-access.service';
import { MeController } from './api/me.controller';
import { RepositoriesController } from './api/repositories.controller';
import { RepositoriesRepository } from './infrastructure/repositories.repository';
import { RepositoriesService } from './application/repositories.service';
import { SystemsController } from './api/systems.controller';
import { SystemsRepository } from './infrastructure/systems.repository';
import { SystemsService } from './application/systems.service';

@Module({
  imports: [
    DatabaseModule,
    AuthIdentityModule,
    EventsModule,
    AuditModule,
    GithubModule, // GithubService (repo creation, installation tokens, Actions secrets)
    AdminModule, // PlatformAdminsRepository, PlatformAdminGuard (global-role overrides, transfer endpoint)
    DirectoryModule, // MemberDirectoryService: who may join a Group
  ],
  controllers: [
    GroupsController,
    SystemsController,
    DeliveryProjectsController,
    RepositoriesController,
    AssignmentsController,
    RepoConfigBrokerController,
    MeController,
  ],
  providers: [
    SessionAuthGuard,
    HierarchyAccessService,
    GroupsRepository,
    GroupsService,
    GroupMembersService,
    GroupActivityRepository,
    GroupActivityService,
    SystemsRepository,
    SystemsService,
    DeliveryProjectsRepository,
    DeliveryProjectsService,
    RepositoriesRepository,
    RepositoriesService,
    AssignmentsRepository,
    AssignmentsService,
    GithubAccessSyncRepository,
    GithubSyncService,
    GithubSyncOutboxHandler,
    GithubTeamAccessStubProvider,
    GithubTeamAccessLiveProvider,
    {
      provide: GithubTeamAccessProvider,
      useFactory: (
        configService: ConfigService,
        stub: GithubTeamAccessStubProvider,
        live: GithubTeamAccessLiveProvider,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app');
        return config.hierarchy.githubSyncMode === 'live' ? live : stub;
      },
      inject: [
        ConfigService,
        GithubTeamAccessStubProvider,
        GithubTeamAccessLiveProvider,
      ],
    },
    RepoConfigurationChangesRepository,
    GithubSecretsProvider,
    {
      provide: GITHUB_SECRETS_BROKER,
      useExisting: GithubSecretsProvider,
    },
    RepoConfigBrokerService,
  ],
})
export class HierarchyModule {}
