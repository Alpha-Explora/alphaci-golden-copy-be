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
import { QaChecklistsModule } from './application/qa-checklists/qa-checklists.module';
import { QaRunsModule } from './application/qa-runs/qa-runs.module';
import { ProjectActivityController } from './api/project-activity.controller';
import { ProjectFolderController } from './api/project-folder.controller';
import { ProjectsController } from './api/projects.controller';
import { ProjectBranchProtectionService } from './application/branch-protection/project-branch-protection.service';
import { ProjectFolderService } from './application/folder/project-folder.service';
import { ProjectCommitsService } from './application/github-activity/project-commits.service';
import { ProjectGithubActivityService } from './application/github-activity/project-github-activity.service';
import { ProjectGithubTokenResolver } from './application/github-activity/project-github-token.resolver';
import { LocalCiRunsProvider } from './application/ci-runs/local-ci-runs.provider';
import { ProjectDashboardSnapshotsRepository } from './infrastructure/project-dashboard-snapshots.repository';
import { ProjectCiRunsService } from './application/ci-runs/project-ci-runs.service';
import { ProjectPreviewsService } from './application/dashboard/project-previews.query-service';
import { UrlEmbeddabilityProbe } from './application/dashboard/url-embeddability.probe';
import { ProjectDriftRepairService } from './application/drift/project-drift-repair.handler';
import { ProjectDashboardService } from './application/dashboard/project-dashboard.service';
import { ProjectDriftRepairApplicationService } from './application/drift/project-drift-repair.service';
import {
  PROJECT_PROVISIONING_PORT,
  ProjectLifecycleService,
} from './application/lifecycle/project-lifecycle.service';
import { ProjectLifecyclePortAdapter } from './application/lifecycle/project-lifecycle-port.adapter';
import { ProjectPreviewsApplicationService } from './application/dashboard/project-previews.service';
import { ProjectWorkflowsService } from './application/workflows/project-workflows.service';
import { ProjectProvisioningService } from './application/lifecycle/project-provisioning.service';
import { ProjectReconciliationService } from './application/lifecycle/project-reconciliation.service';
import { ProjectProvisioningApplicationService } from './application/lifecycle/project-provisioning-application.service';
import { ProjectWorkflowSettingsRepository } from './infrastructure/project-workflow-settings.repository';
import { ProjectWorkflowUpdateRequestsRepository } from './infrastructure/project-workflow-update-requests.repository';
import { ProjectsRepository } from './infrastructure/projects.repository';
import { ProjectWorkspaceController } from './api/project-workspace.controller';
import { ProjectWorkspaceService } from './application/workspace/project-workspace.service';
import { ProjectsService } from './application/lifecycle/projects.service';
import { SonarCloudSetupService } from './application/lifecycle/sonar-cloud-setup.service';
import { ProjectReferenceModule } from './project-reference.module';
import { ProjectVisibilityModule } from './project-visibility.module';

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
    ProjectReferenceModule,
    ProjectVisibilityModule,
    QaChecklistsModule,
    QaRunsModule,
  ],
  controllers: [
    ProjectsController,
    ProjectWorkspaceController,
    ProjectFolderController,
    ProjectActivityController,
  ],
  providers: [
    ProjectsService,
    {
      provide: PROJECT_PROVISIONING_PORT,
      useExisting: ProjectProvisioningApplicationService,
    },
    ProjectLifecycleService,
    ProjectLifecyclePortAdapter,
    SonarCloudSetupService,
    ProjectDashboardService,
    ProjectWorkflowsService,
    ProjectPreviewsApplicationService,
    ProjectDriftRepairApplicationService,
    ProjectProvisioningService,
    ProjectReconciliationService,
    ProjectProvisioningApplicationService,
    ProjectWorkspaceService,
    ProjectGithubTokenResolver,
    ProjectGithubActivityService,
    ProjectCommitsService,
    ProjectBranchProtectionService,
    ProjectFolderService,
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
  exports: [
    ProjectProvisioningService,
    ProjectReconciliationService,
    ProjectLifecyclePortAdapter,
  ],
})
export class ProjectsModule {}
