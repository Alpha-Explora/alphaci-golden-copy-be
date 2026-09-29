import { Global, Module } from '@nestjs/common';

import { PROJECT_LIFECYCLE_PORT } from '#kernel/ports/project-lifecycle.port';
import { PROJECT_LOOKUP } from '#kernel/ports/project-lookup.port';
import { WORKSPACE_DATA_CLEANUP } from '#kernel/ports/workspace-data-cleanup.port';
import { ProjectLifecyclePortAdapter } from './application/lifecycle/project-lifecycle-port.adapter';
import { ProjectProvisioningService } from './application/lifecycle/project-provisioning.service';
import { QaChecklistsModule } from './application/qa-checklists/qa-checklists.module';
import { QaChecklistsService } from './application/qa-checklists/qa-checklists.service';
import { ProjectsModule } from './projects.module';

/** Composition-only bridge for identity-access consumers of project creation/ */
@Global()
@Module({
  imports: [ProjectsModule, QaChecklistsModule],
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
    // Delivery-project (Project folder) deletion (identity-access/hierarchy)
    // deletes each linked AlphaCI project through this port; projects owns
    // disconnectProject and the GitHub/Render/Vercel/Sonar teardown it reuses.
    {
      provide: PROJECT_LIFECYCLE_PORT,
      useExisting: ProjectLifecyclePortAdapter,
    },
  ],
  exports: [PROJECT_LOOKUP, WORKSPACE_DATA_CLEANUP, PROJECT_LIFECYCLE_PORT],
})
export class ProjectProvisioningModule {}
