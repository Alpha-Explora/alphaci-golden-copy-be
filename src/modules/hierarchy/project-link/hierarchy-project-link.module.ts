import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../../kernel/db/database.module';
import { HierarchyProjectLinkRepository } from './hierarchy-project-link.repository';
import { HierarchyProjectLinkService } from './hierarchy-project-link.service';

/** Composition boundary for the project-to-hierarchy link adapter. */
@Module({
  imports: [DatabaseModule],
  providers: [HierarchyProjectLinkRepository, HierarchyProjectLinkService],
  exports: [HierarchyProjectLinkService],
})
export class HierarchyProjectLinkModule {}
