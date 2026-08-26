import { Global, Module } from '@nestjs/common';

import { PROJECT_LOOKUP } from '#kernel/ports/project-lookup.port';
import { ProjectProvisioningService } from './application/lifecycle/project-provisioning.service';
import { ProjectsModule } from './projects.module';

/** Composition-only bridge for identity-access consumers of project creation/ */
@Global()
@Module({
  imports: [ProjectsModule],
  providers: [
    {
      provide: PROJECT_LOOKUP,
      useExisting: ProjectProvisioningService,
    },
  ],
  exports: [PROJECT_LOOKUP],
})
export class ProjectProvisioningModule {}
