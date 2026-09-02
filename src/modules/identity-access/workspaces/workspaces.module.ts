import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { DatabaseModule } from '#kernel/db/database.module';
import { WorkspacesController } from './api/workspaces.controller';
import { WorkspaceAccessService } from './application/workspace-access.service';
import { WorkspacesRepository } from './infrastructure/workspaces.repository';
import { WorkspacesService } from './application/workspaces.service';
import {
  WORKSPACES_PORT,
  WORKSPACE_ACCESS_PORT,
} from '#kernel/ports/workspaces.port';

@Module({
  imports: [DatabaseModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesRepository,
    WorkspacesService,
    WorkspaceAccessService,
    { provide: WORKSPACES_PORT, useExisting: WorkspacesService },
    { provide: WORKSPACE_ACCESS_PORT, useExisting: WorkspaceAccessService },
    SessionAuthGuard,
  ],
  exports: [
    WorkspacesService,
    WorkspaceAccessService,
    WORKSPACES_PORT,
    WORKSPACE_ACCESS_PORT,
  ],
})
export class WorkspacesModule {}
