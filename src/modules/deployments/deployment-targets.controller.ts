import {
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, catchError, interval, of, startWith, switchMap } from 'rxjs';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import type { CreateDeploymentTargetDto } from './dto/create-deployment-target.dto';
import type { DetachDeploymentTargetDto } from './dto/detach-deployment-target.dto';
import { DeploymentTargetsService } from './deployment-targets.service';
import type { UpdateDeploymentTargetMetadataInput } from './deployment-targets.repository';
import { EnvFeatureGuard } from './env-feature.guard';

const LOG_STREAM_POLL_INTERVAL_MS = 5_000;

function logFilters(
  type?: string,
  startTime?: string,
  endTime?: string,
): { type?: string; startTime?: string; endTime?: string } {
  return {
    ...(type ? { type } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
  };
}

@Controller('projects/:projectId/deployment-targets')
@UseGuards(SessionAuthGuard, SubscriptionGuard, EnvFeatureGuard)
export class DeploymentTargetsController {
  constructor(private readonly service: DeploymentTargetsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.service.listDeploymentTargets(projectId, req.session.user!.id);
  }

  @Post()
  create(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: CreateDeploymentTargetDto,
  ) {
    return this.service.createDeploymentTarget(
      projectId,
      req.session.user!.id,
      body,
    );
  }

  @Get(':targetId/actions')
  actions(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.service.getDeploymentTargetActions(
      projectId,
      targetId,
      req.session.user!.id,
    );
  }

  @Post(':targetId/sync')
  sync(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.service.syncDeploymentTarget(
      projectId,
      targetId,
      req.session.user!.id,
    );
  }

  @Patch(':targetId')
  update(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
    @Body() body: UpdateDeploymentTargetMetadataInput,
  ) {
    return this.service.updateDeploymentTargetMetadata(
      projectId,
      targetId,
      req.session.user!.id,
      body,
    );
  }

  @Get(':targetId/logs')
  logs(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
    @Query('type') type?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    return this.service.getDeploymentTargetLogs(
      projectId,
      targetId,
      req.session.user!.id,
      logFilters(type, startTime, endTime),
    );
  }

  /**
   * Live-tail: pushes the log snapshot on an interval instead of making the
   * browser re-poll over plain HTTP. Each tick re-sends the full current
   * result (same shape as GET .../logs) rather than an incremental diff —
   * the frontend already knows how to render a full snapshot, so this keeps
   * client and server in lockstep without inventing a separate diffing
   * protocol. Polls at the same cadence the frontend already used for HTTP
   * polling, so this doesn't increase load on Render/Vercel — it only moves
   * who initiates the request.
   */
  @Sse(':targetId/logs/stream')
  logsStream(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
    @Query('type') type?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Observable<MessageEvent> {
    const userId = req.session.user!.id;
    const filters = logFilters(type, startTime, endTime);

    return interval(LOG_STREAM_POLL_INTERVAL_MS).pipe(
      startWith(0),
      switchMap(() =>
        this.service.getDeploymentTargetLogs(
          projectId,
          targetId,
          userId,
          filters,
        ),
      ),
      switchMap((result) => of({ data: result }) as Observable<MessageEvent>),
      catchError((error: unknown) =>
        of({
          data: {
            source: 'simulated' as const,
            reason: error instanceof Error ? error.message : String(error),
            logs: [],
          },
        }),
      ),
    );
  }

  @Delete(':targetId')
  detach(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
    @Body() body?: DetachDeploymentTargetDto,
  ) {
    return this.service.detachDeploymentTarget(
      projectId,
      targetId,
      req.session.user!.id,
      body,
    );
  }
}
