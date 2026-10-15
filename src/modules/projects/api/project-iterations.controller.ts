import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type {
  ProjectIterationCurrent,
  ProjectIterationList,
  StartedIteration,
} from '../application/qa-checklists/project-iterations.contracts';
import { ProjectIterationsService } from '../application/qa-checklists/project-iterations.service';
import { StartIterationDto } from '../application/qa-runs/dto/start-iteration.dto';
import { ProjectIterationStartService } from '../application/qa-runs/project-iteration-start.service';
import { QaProjectDeliveryService } from '../application/qa-runs/qa-project-delivery.service';
import { actorContext, requireUserId } from './qa-runs.controller';

/**
 * A Project's Iterations (ITERATIONS_PLAN.md section 5). Visibility is the
 * same as every other Project QA route: an active member of the Project's
 * group; a non-member gets 404. Starting the next Iteration is lead/admin only; the
 * Merge to main routes that deliver an Iteration live with the promotion
 * controllers.
 */
@Controller('delivery-projects/:deliveryProjectId/iterations')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class DeliveryProjectIterationsController {
  constructor(
    private readonly iterations: ProjectIterationsService,
    private readonly delivery: QaProjectDeliveryService,
    private readonly starter: ProjectIterationStartService,
  ) {}

  /**
   * Starts the next Iteration (lead/admin), empty: nothing is carried over.
   * 409 ITERATION_ACTIVE while one is active or on a lost race; 400
   * ITERATION_CARRY_INVALID when items are named to carry over.
   */
  @Post()
  start(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
    @Body() body: StartIterationDto,
  ): Promise<StartedIteration> {
    return this.starter.start(deliveryProjectId, actorContext(req), body);
  }

  /** The Project's Iterations, newest first. */
  @Get()
  list(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ): Promise<ProjectIterationList> {
    return this.iterations.listForProject(
      deliveryProjectId,
      requireUserId(req),
    );
  }

  /**
   * The active Iteration, or the last delivered one when none is active, with
   * its stored per-repository delivery state, the repositories the signed-off
   * run covers, and whether the caller may Merge all repositories.
   */
  @Get('current')
  current(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ): Promise<ProjectIterationCurrent> {
    return this.delivery.current(deliveryProjectId, actorContext(req));
  }
}
