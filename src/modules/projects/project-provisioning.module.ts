import { Global, Module } from '@nestjs/common';

import { PROJECT_LOOKUP } from '#kernel/ports/project-lookup.port';
import { WORKSPACE_DATA_CLEANUP } from '#kernel/ports/workspace-data-cleanup.port';
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
  ],
  exports: [PROJECT_LOOKUP, WORKSPACE_DATA_CLEANUP],
})
export class ProjectProvisioningModule {}
