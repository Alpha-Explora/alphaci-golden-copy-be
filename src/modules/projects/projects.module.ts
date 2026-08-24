import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { AuditModule } from '../audit/audit.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DatabaseModule } from '../../kernel/db/database.module';
import { HierarchyProjectLinkRepository } from '../hierarchy/project-link/hierarchy-project-link.repository';
import { HierarchyProjectLinkService } from '../hierarchy/project-link/hierarchy-project-link.service';
import { GithubModule } from '../github/github.module';
import { CiModule } from '../ci/index.js';
import { DeploymentsModule } from '../deployments/index.js';
import { NotificationsModule } from '../notifications/index.js';
import { SubscriptionModule } from '../subscription/subscription.module';
import { UsageModule } from '../usage/usage.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { WorkflowsModule } from '../workflows/index.js';
import { ProjectsController } from './projects.controller';
import { LocalCiRunsProvider } from './local-ci-runs.provider';
import { ProjectDashboardSnapshotsRepository } from './project-dashboard-snapshots.repository';
import { ProjectCiRunsService } from './project-ci-runs.service';
import { ProjectPreviewsService } from './project-previews.service';
import { UrlEmbeddabilityProbe } from './url-embeddability.probe';
import { ProjectDriftRepairService } from './project-drift-repair.service';
import { ProjectWorkflowSettingsRepository } from './project-workflow-settings.repository';
import { ProjectWorkflowUpdateRequestsRepository } from './project-workflow-update-requests.repository';
import { ProjectsRepository } from './projects.repository';
import { ProjectWorkspaceController } from './project-workspace.controller';
import { ProjectWorkspaceService } from './project-workspace.service';
import { ProjectsService } from './projects.service';

@Module({
  imports: [
    DatabaseModule,
    CatalogModule, // CatalogService
    GithubModule, // GithubService
    CiModule, // CiService
    DeploymentsModule, // ProjectDeploymentProvisioningService
    SubscriptionModule, // SubscriptionService (needed by SubscriptionGuard)
    UsageModule,
    AuditModule,
    WorkspacesModule,
    NotificationsModule,
    WorkflowsModule,
  ],
  controllers: [ProjectsController, ProjectWorkspaceController],
  providers: [
    ProjectsService,
    ProjectWorkspaceService,
    ProjectCiRunsService,
    ProjectPreviewsService,
    UrlEmbeddabilityProbe,
    ProjectDriftRepairService,
    LocalCiRunsProvider,
    ProjectsRepository,
    // Registered directly rather than by importing HierarchyModule — the same
    // pattern HierarchyModule uses for ProjectsRepository, and for the same
    // reason: it keeps Projects and Hierarchy from importing each other.
    HierarchyProjectLinkRepository,
    HierarchyProjectLinkService,
    ProjectDashboardSnapshotsRepository,
    ProjectWorkflowSettingsRepository,
    ProjectWorkflowUpdateRequestsRepository,
    SessionAuthGuard,
    SubscriptionGuard,
  ],
})
export class ProjectsModule {}
