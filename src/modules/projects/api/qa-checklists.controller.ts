import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { QaChecklistsService } from '../application/qa-checklists/qa-checklists.service';
import { CreateQaChecklistDto } from '../application/qa-checklists/dto/create-qa-checklist.dto';
import { UpdateQaChecklistDto } from '../application/qa-checklists/dto/update-qa-checklist.dto';
import { ReplaceQaChecklistItemsDto } from '../application/qa-checklists/dto/replace-qa-checklist-items.dto';
import { ShareQaChecklistProjectsDto } from '../application/qa-checklists/dto/share-qa-checklist-projects.dto';
import { UpdateQaChecklistProjectsDto } from '../application/qa-checklists/dto/update-qa-checklist-projects.dto';

function requireUserId(req: Request): string {
  const userId = req.session.user?.id ?? req.session.userId;
  if (!userId) {
    throw new UnauthorizedException('Authentication required');
  }
  return userId;
}

/**
 * Team-lead checklist authoring, at workspace scope. GET is open to any
 * workspace member; the write routes are further restricted to lead/admin
 * inside QaChecklistsService (a non-member gets 404 from either route, never
 * a 403 that would confirm the workspace exists).
 */
@Controller('workspaces/:workspaceId/qa-checklists')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class WorkspaceQaChecklistsController {
  constructor(private readonly qaChecklistsService: QaChecklistsService) {}

  @Get()
  list(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.qaChecklistsService.listForWorkspace(
      workspaceId,
      requireUserId(req),
      includeArchived === 'true',
    );
  }

  @Post()
  create(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateQaChecklistDto,
  ) {
    return this.qaChecklistsService.createForWorkspace(
      workspaceId,
      requireUserId(req),
      body,
    );
  }
}

/** Checklist-id-scoped routes: read, edit, item replace, archive, and sharing. */
@Controller('qa-checklists')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class QaChecklistsController {
  constructor(private readonly qaChecklistsService: QaChecklistsService) {}

  @Get(':id')
  getById(@Req() req: Request, @Param('id') id: string) {
    return this.qaChecklistsService.getById(id, requireUserId(req));
  }

  @Patch(':id')
  updateMeta(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateQaChecklistDto,
  ) {
    return this.qaChecklistsService.updateMeta(id, requireUserId(req), body);
  }

  @Put(':id/items')
  replaceItems(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ReplaceQaChecklistItemsDto,
  ) {
    return this.qaChecklistsService.replaceItems(id, requireUserId(req), body);
  }

  @Post(':id/archive')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.qaChecklistsService.archive(id, requireUserId(req));
  }

  @Put(':id/projects')
  setSharedProjects(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ShareQaChecklistProjectsDto,
  ) {
    return this.qaChecklistsService.setSharedProjects(
      id,
      requireUserId(req),
      body,
    );
  }

  @Patch(':id/projects')
  updateSharedProjects(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateQaChecklistProjectsDto,
  ) {
    return this.qaChecklistsService.updateSharedProjects(
      id,
      requireUserId(req),
      body,
    );
  }
}

/** Project-scoped read: any checklist the project's workspace has shared to it. */
@Controller('projects/:projectId/qa-checklists')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class ProjectQaChecklistsController {
  constructor(private readonly qaChecklistsService: QaChecklistsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.qaChecklistsService.listForProject(
      projectId,
      requireUserId(req),
    );
  }
}
