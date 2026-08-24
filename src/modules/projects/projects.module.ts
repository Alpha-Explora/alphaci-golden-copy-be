import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DatabaseModule } from '../../kernel/db/database.module';
import { HierarchyProjectLinkModule } from '../hierarchy/project-link/index.js';
import { GithubModule } from '../github/github.module.js';
import { CiModule } from '../ci/ci.module.js';
import { DeploymentsModule } from '../deployments/deployments.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { UsageModule } from '../usage/usage.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { ProjectsController } from './projects.controller';
import { LocalCiRunsProvider } from './local-ci-runs.provider';
import { ProjectDashboardSnapshotsRepository } from './project-dashboard-snapshots.repository';
import { ProjectCiRunsService } from './project-ci-runs.service';
import { ProjectPreviewsService } from './project-previews.service';
import { UrlEmbeddabilityProbe } from './url-embeddability.probe';
import { ProjectDriftRepairService } from './project-drift-repair.service';
import { ProjectDashboardService } from './application/project-dashboard.service';
import { ProjectDriftRepairApplicationService } from './application/project-drift-repair.service';
import { ProjectLifecycleService } from './application/project-lifecycle.service';
import { ProjectPreviewsApplicationService } from './application/project-previews.service';
import { ProjectWorkflowsService } from './application/project-workflows.service';
import { ProjectProvisioningService } from './application/project-provisioning.service';
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
    HierarchyProjectLinkModule,
  ],
  controllers: [ProjectsController, ProjectWorkspaceController],
  providers: [
    ProjectsService,
    ProjectLifecycleService,
    ProjectDashboardService,
    ProjectWorkflowsService,
    ProjectPreviewsApplicationService,
    ProjectDriftRepairApplicationService,
    ProjectProvisioningService,
    ProjectWorkspaceService,
    ProjectCiRunsService,
    ProjectPreviewsService,
    UrlEmbeddabilityProbe,
    ProjectDriftRepairService,
    LocalCiRunsProvider,
    ProjectsRepository,
    ProjectDashboardSnapshotsRepository,
    ProjectWorkflowSettingsRepository,
    ProjectWorkflowUpdateRequestsRepository,
    SessionAuthGuard,
    SubscriptionGuard,
  ],
  exports: [ProjectProvisioningService],
})
export class ProjectsModule {}
