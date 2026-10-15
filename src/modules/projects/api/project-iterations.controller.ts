import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import {
  CapabilityGuard,
  RequiresCapability,
} from '#kernel/composition/index.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import type {
  ProjectIterationCurrent,
  ProjectIterationList,
} from '../application/qa-checklists/project-iterations.contracts';
import { ProjectIterationsService } from '../application/qa-checklists/project-iterations.service';
import { requireUserId } from './qa-runs.controller';

/**
 * A Project's Iterations (ITERATIONS_PLAN.md section 5). Visibility is the
 * same as every other Project QA route: an active member of the Project's
 * group; a non-member gets 404. Reads only in phase 1.
 */
@Controller('delivery-projects/:deliveryProjectId/iterations')
@UseGuards(SessionAuthGuard, CapabilityGuard)
@RequiresCapability('projects.qa-checklists')
export class DeliveryProjectIterationsController {
  constructor(private readonly iterations: ProjectIterationsService) {}

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

  /** The active Iteration, or the last delivered one when none is active. */
  @Get('current')
  current(
    @Req() req: Request,
    @Param('deliveryProjectId') deliveryProjectId: string,
  ): Promise<ProjectIterationCurrent> {
    return this.iterations.currentForProject(
      deliveryProjectId,
      requireUserId(req),
    );
  }
}
