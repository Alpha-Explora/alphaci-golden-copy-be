import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { DatabaseModule } from '../../kernel/db/database.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspacesRepository } from './workspaces.repository';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [DatabaseModule, PersistenceModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesRepository,
    WorkspacesService,
    WorkspaceAccessService,
    SessionAuthGuard,
  ],
  exports: [WorkspacesService, WorkspaceAccessService],
})
export class WorkspacesModule {}
