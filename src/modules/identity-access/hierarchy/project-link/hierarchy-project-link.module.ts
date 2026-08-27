import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { HierarchyProjectLinkRepository } from './hierarchy-project-link.repository';
import { HierarchyProjectLinkService } from './hierarchy-project-link.service';
import { PROJECT_LINK_PORT } from '#kernel/ports/project-link.port';

/** Composition boundary for the project-to-hierarchy link adapter. */
@Module({
  imports: [DatabaseModule],
  providers: [
    HierarchyProjectLinkRepository,
    HierarchyProjectLinkService,
    { provide: PROJECT_LINK_PORT, useExisting: HierarchyProjectLinkService },
  ],
  exports: [HierarchyProjectLinkService, PROJECT_LINK_PORT],
})
export class HierarchyProjectLinkModule {}
