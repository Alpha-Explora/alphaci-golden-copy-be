import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { AssignmentsService } from '../application/assignments.service';

@Controller('repositories/:repositoryId')
@UseGuards(SessionAuthGuard)
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  @Post('assignments')
  createAssignment(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Body() body: CreateAssignmentDto,
  ) {
    return this.assignmentsService.createAssignment(
      repositoryId,
      this.requireUserId(req),
      body,
    );
  }

  @Get('assignments')
  listAssignments(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.assignmentsService.listAssignments(
      repositoryId,
      this.requireUserId(req),
    );
  }

  @Delete('assignments/:assignmentId')
  removeAssignment(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    return this.assignmentsService.removeAssignment(
      repositoryId,
      this.requireUserId(req),
      assignmentId,
    );
  }

  @Post('assignments/:assignmentId/reconcile')
  reconcileAssignment(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
    @Param('assignmentId') assignmentId: string,
  ) {
    return this.assignmentsService.reconcile(
      repositoryId,
      this.requireUserId(req),
      assignmentId,
    );
  }

  @Get('access-status')
  getAccessStatus(
    @Req() req: Request,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.assignmentsService.getAccessStatus(
      repositoryId,
      this.requireUserId(req),
    );
  }

  private requireUserId(req: Request): string {
    const user = req.session.user;
    const userId = user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
