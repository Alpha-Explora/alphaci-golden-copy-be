import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { AuditModule } from '#modules/platform-ops/audit/audit.module.js';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { HierarchyProjectLinkModule } from '#modules/identity-access/hierarchy/project-link/index.js';
import { GithubModule } from '#modules/pipelines/github/github.module.js';
import { CiModule } from '#modules/pipelines/ci/ci.module.js';
import { RuntimeModule } from '#modules/runtime/runtime.module.js';
import { NotificationsModule } from '#modules/platform-ops/notifications/notifications.module.js';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { UsageModule } from '#modules/billing/usage/usage.module.js';
import { WorkspacesModule } from '#modules/identity-access/workspaces/workspaces.module.js';
import { WorkflowsModule } from './application/workflows/workflows.module';
import { ExistingReposModule } from './application/existing-repos/existing-repos.module';
import { CatalogModule } from './application/catalog/catalog.module';
import { ProjectsController } from './projects.controller';
import { LocalCiRunsProvider } from './local-ci-runs.provider';
import { ProjectDashboardSnapshotsRepository } from './project-dashboard-snapshots.repository';
import { ProjectCiRunsService } from './project-ci-runs.service';
import { ProjectPreviewsService } from './project-previews.service';
import { UrlEmbeddabilityProbe } from './url-embeddability.probe';
import { ProjectDriftRepairService } from './project-drift-repair.service';
import { ProjectDashboardService } from './application/dashboard/project-dashboard.service';
import { ProjectDriftRepairApplicationService } from './application/drift/project-drift-repair.service';
import { ProjectLifecycleService } from './application/lifecycle/project-lifecycle.service';
import { ProjectPreviewsApplicationService } from './application/dashboard/project-previews.service';
import { ProjectWorkflowsService } from './application/workflows/project-workflows.service';
import { ProjectProvisioningService } from './application/lifecycle/project-provisioning.service';
import { ProjectWorkflowSettingsRepository } from './project-workflow-settings.repository';
import { ProjectWorkflowUpdateRequestsRepository } from './project-workflow-update-requests.repository';
import { ProjectsRepository } from './projects.repository';
import { ProjectWorkspaceController } from './project-workspace.controller';
import { ProjectWorkspaceService } from './project-workspace.service';
import { ProjectsService } from './projects.service';

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    GithubModule, // GithubService
    CiModule, // CiService
    RuntimeModule, // ProjectDeploymentProvisioningService
    SubscriptionModule, // SubscriptionService (needed by SubscriptionGuard)
    UsageModule,
    AuditModule,
    WorkspacesModule,
    NotificationsModule,
    WorkflowsModule,
    ExistingReposModule,
    CatalogModule,
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
