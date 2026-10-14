import { Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module';
import { HierarchyModule } from '../hierarchy.module';
import { HierarchyProjectLinkRepository } from './infrastructure/hierarchy-project-link.repository';
import { HierarchyProjectLinkService } from './application/hierarchy-project-link.service';
import { DELIVERY_PROJECT_OVERVIEW_QUERY } from '#kernel/ports/delivery-project-overview.port';
import { PROJECT_LINK_PORT } from '#kernel/ports/project-link.port';

/**
 * Composition boundary for the project-to-hierarchy link adapter.
 *
 * Imports HierarchyModule for HierarchyAccessService and
 * DeliveryProjectsRepository — the up-front deliveryProjectId gate
 * (assertDeliveryProjectAvailableForCreate) reuses the same Lead/Admin
 * creator-role semantics `createSystem`/`createRepository` already assert,
 * rather than re-deriving them here. HierarchyModule does not import this
 * module back, so there is no cycle.
 */
@Module({
  imports: [DatabaseModule, HierarchyModule],
  providers: [
    HierarchyProjectLinkRepository,
    HierarchyProjectLinkService,
    { provide: PROJECT_LINK_PORT, useExisting: HierarchyProjectLinkService },
    // Batched member / repository facts for the projects context's team overview.
    {
      provide: DELIVERY_PROJECT_OVERVIEW_QUERY,
      useExisting: HierarchyProjectLinkService,
    },
  ],
  exports: [
    HierarchyProjectLinkService,
    PROJECT_LINK_PORT,
    DELIVERY_PROJECT_OVERVIEW_QUERY,
  ],
})
export class HierarchyProjectLinkModule {}
