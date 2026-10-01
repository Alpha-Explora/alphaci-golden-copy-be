import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CreateRequirementDto } from '../application/qa-checklists/dto/create-requirement.dto';
import { ReorderRequirementItemsDto } from '../application/qa-checklists/dto/reorder-requirement-items.dto';
import { RequirementItemDto } from '../application/qa-checklists/dto/requirement-item.dto';
import { SetProgressDto } from '../application/qa-checklists/dto/set-progress.dto';
import { UpdateRequirementItemDto } from '../application/qa-checklists/dto/update-requirement-item.dto';
import { UpdateRequirementDto } from '../application/qa-checklists/dto/update-requirement.dto';
import { QaRequirementsService } from '../application/qa-checklists/qa-requirements.service';
import { actorContext, requireUserId } from './qa-runs.controller';

/**
 * A Project's requirements: Features with User stories (functional) and
 * system checklists (system). Any member of the Project's group reads; lead and
 * admin write (QaRequirementsService answers 403 REQUIREMENT_MANAGE_FORBIDDEN
 * to everyone else, and 404 to a non-member).
 */
@Controller('delivery-projects/:deliveryProjectId/requirements')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class DeliveryProjectRequirementsController {
  constructor(private readonly requirementsService: QaRequirementsService) {}

  @Get()
  list(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Query('kind') kind?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.requirementsService.listForProject(
      deliveryProjectId,
      requireUserId(req),
      { kind, includeArchived: includeArchived === 'true' },
    );
  }

  @Post()
  create(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Body() body: CreateRequirementDto,
  ) {
    return this.requirementsService.create(
      deliveryProjectId,
      requireUserId(req),
      body,
    );
  }
}

/** Requirement-id-scoped routes: read, edit, archive, items, and Progress. */
@Controller('requirements')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class RequirementsController {
  constructor(private readonly requirementsService: QaRequirementsService) {}

  @Get(':id')
  getById(@Req() req: Request, @Param('id') id: string) {
    return this.requirementsService.getById(id, requireUserId(req));
  }

  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateRequirementDto,
  ) {
    return this.requirementsService.update(id, requireUserId(req), body);
  }

  @Post(':id/archive')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.requirementsService.archive(id, requireUserId(req));
  }

  @Post(':id/items')
  addItem(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: RequirementItemDto,
  ) {
    return this.requirementsService.addItem(id, requireUserId(req), body);
  }

  // Declared before ':itemId' routes so the literal 'order' segment is matched first.
  @Put(':id/items/order')
  reorderItems(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ReorderRequirementItemsDto,
  ) {
    return this.requirementsService.reorderItems(id, requireUserId(req), body);
  }

  @Patch(':id/items/:itemId')
  updateItem(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: UpdateRequirementItemDto,
  ) {
    return this.requirementsService.updateItem(
      id,
      itemId,
      requireUserId(req),
      body,
    );
  }

  @Delete(':id/items/:itemId')
  @HttpCode(204)
  async deleteItem(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    await this.requirementsService.deleteItem(id, itemId, requireUserId(req));
  }

  /** The developer track: todo / in_progress / done. QA verifies instead. */
  @Patch(':id/items/:itemId/progress')
  setProgress(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: SetProgressDto,
  ) {
    const actor = actorContext(req);
    return this.requirementsService.setProgress(
      id,
      itemId,
      { userId: actor.userId, userLogin: actor.userLogin },
      body,
    );
  }
}

/** Team-level, read-only overview of every Project's requirements. */
@Controller('workspaces/:workspaceId/qa-requirements')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class WorkspaceQaRequirementsController {
  constructor(private readonly requirementsService: QaRequirementsService) {}

  @Get('overview')
  overview(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.requirementsService.overview(
      workspaceId,
      requireUserId(req),
      includeArchived === 'true',
    );
  }
}
