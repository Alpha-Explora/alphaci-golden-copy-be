import { Global, Module } from '@nestjs/common';

import { DELIVERY_PROJECT_REPOSITORY_PROVISIONING } from '#kernel/ports/delivery-project-repository-provisioning.port';
import { DELIVERY_PROJECT_DATA_CLEANUP } from '#kernel/ports/delivery-project-data-cleanup.port';
import { PROJECT_LIFECYCLE_PORT } from '#kernel/ports/project-lifecycle.port';
import { PROJECT_LOOKUP } from '#kernel/ports/project-lookup.port';
import { PROJECT_REQUIREMENTS_READINESS } from '#kernel/ports/project-requirements-readiness.port';
import { WORKSPACE_DATA_CLEANUP } from '#kernel/ports/workspace-data-cleanup.port';
import { DeliveryProjectRepositoryProvisioningAdapter } from './application/lifecycle/delivery-project-repository-provisioning.adapter';
import { ProjectLifecyclePortAdapter } from './application/lifecycle/project-lifecycle-port.adapter';
import { ProjectProvisioningService } from './application/lifecycle/project-provisioning.service';
import { ProjectRequirementsReadinessAdapter } from './application/qa-checklists/project-requirements-readiness.adapter';
import { QaChecklistsModule } from './application/qa-checklists/qa-checklists.module';
import { QaChecklistsService } from './application/qa-checklists/qa-checklists.service';
import { QaRequirementsService } from './application/qa-checklists/qa-requirements.service';
import { QaRunsModule } from './application/qa-runs/qa-runs.module';
import { ProjectsModule } from './projects.module';

/** Composition-only bridge for identity-access consumers of project creation/ */
@Global()
@Module({
  imports: [ProjectsModule, QaChecklistsModule, QaRunsModule],
  providers: [
    {
      provide: PROJECT_LOOKUP,
      useExisting: ProjectProvisioningService,
    },
    // Workspace deletion (identity-access) removes the workspace's QA
    // checklists through this port; projects owns those tables.
    {
      provide: WORKSPACE_DATA_CLEANUP,
      useExisting: QaChecklistsService,
    },
    // Project (delivery project) deletion removes the Project's QA
    // requirements through this port; projects owns those tables.
    {
      provide: DELIVERY_PROJECT_DATA_CLEANUP,
      useExisting: QaRequirementsService,
    },
    // The hierarchy repository create and the project-folders listing
    // (identity-access) read a Project's active Feature count through this
    // port; projects owns qa_checklists.
    {
      provide: PROJECT_REQUIREMENTS_READINESS,
      useExisting: ProjectRequirementsReadinessAdapter,
    },
    // Delivery-project (Project folder) deletion (identity-access/hierarchy)
    // deletes each linked AlphaCI project through this port; projects owns
    // disconnectProject and the GitHub/Render/Vercel/Sonar teardown it reuses.
    {
      provide: PROJECT_LIFECYCLE_PORT,
      useExisting: ProjectLifecyclePortAdapter,
    },
    // "Add repository" inside a Project (identity-access/hierarchy) runs the
    // wizard's full provisioning for one repository through this port;
    // projects owns the GitHub, workflow and hosting steps.
    {
      provide: DELIVERY_PROJECT_REPOSITORY_PROVISIONING,
      useExisting: DeliveryProjectRepositoryProvisioningAdapter,
    },
  ],
  exports: [
    PROJECT_LOOKUP,
    WORKSPACE_DATA_CLEANUP,
    DELIVERY_PROJECT_DATA_CLEANUP,
    PROJECT_REQUIREMENTS_READINESS,
    PROJECT_LIFECYCLE_PORT,
    DELIVERY_PROJECT_REPOSITORY_PROVISIONING,
  ],
})
export class ProjectProvisioningModule {}
