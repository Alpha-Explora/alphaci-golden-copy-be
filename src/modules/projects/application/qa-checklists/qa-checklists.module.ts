import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import {
  ProjectQaChecklistsController,
  QaChecklistsController,
  WorkspaceQaChecklistsController,
} from '../../api/qa-checklists.controller';
import { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { QaAccessService } from './qa-access.service';
import { QaChecklistsService } from './qa-checklists.service';

@Module({
  imports: [DatabaseModule, EventsModule],
  controllers: [
    WorkspaceQaChecklistsController,
    QaChecklistsController,
    ProjectQaChecklistsController,
  ],
  providers: [
    SessionAuthGuard,
    QaChecklistsRepository,
    // ProjectsRepository is declared here too, even though ProjectsModule
    // (which imports this module) already provides it. Nest scopes a
    // provider to the module that declares it — a provider in ProjectsModule
    // is not visible inside an imported module's own injector unless
    // ProjectsModule exports it, and ProjectsModule doesn't (importing it
    // back from here to consume that export would be circular, since
    // ProjectsModule imports QaChecklistsModule for its controllers). The
    // result is two ProjectsRepository instances app-wide, both thin,
    // stateless wrappers around the one true DatabaseService singleton
    // (DatabaseModule IS deduplicated app-wide by Nest), so this costs an
    // extra object, not a second connection pool or any behavioral drift.
    ProjectsRepository,
    QaAccessService,
    QaChecklistsService,
  ],
  // QaChecklistsRepository is also exported so the qa-runs sibling module
  // (which needs to read checklist rows/items when creating a run) can
  // import this module rather than re-declaring the repository a second
  // time — see the comment above on why ProjectsRepository itself has to be
  // re-declared instead: that one is a re-declare because re-exporting it
  // would require ProjectsModule to export it too, which it deliberately
  // does not. QaChecklistsRepository has no such constraint: it is only ever
  // provided here, so exporting it is the clean option.
  exports: [QaChecklistsService, QaAccessService, QaChecklistsRepository],
})
export class QaChecklistsModule {}
