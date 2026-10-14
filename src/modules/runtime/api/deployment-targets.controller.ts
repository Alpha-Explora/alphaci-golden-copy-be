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
import { Observable, catchError, defer, map, of, switchMap } from 'rxjs';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import type { CreateDeploymentTargetDto } from './dto/create-deployment-target.dto';
import type { DetachDeploymentTargetDto } from './dto/detach-deployment-target.dto';
import { DeploymentTargetsService } from '../application/deployment-targets.service';
import type { UpdateDeploymentTargetMetadataInput } from '../core/deployments.types';
import { parseDeploymentLogsQuery } from './deployment-logs-stream.util';
import { DeploymentLogsHubService } from '../application/deployment-logs-hub.service';

@Controller('projects/:projectId/deployment-targets')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
export class DeploymentTargetsController {
  constructor(
    private readonly service: DeploymentTargetsService,
    private readonly logsHub: DeploymentLogsHubService,
  ) {}

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

  /**
   * Re-runs this target's CI secrets install without recreating anything at
   * the provider — for a target created before a secret this platform now
   * installs existed (e.g. the Vercel automation bypass secret), or whose
   * installed secrets need rotating. Requires the signed-in user's own GitHub
   * token, read the same way `syncProjects` (projects.controller.ts) reads it.
   */
  @Post(':targetId/reinstall-secrets')
  reinstallSecrets(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.service.reinstallDeploymentSecrets(
      projectId,
      targetId,
      req.session.user!.id,
      req.session.githubAccessToken ?? null,
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
    @Query('direction') direction?: string,
    @Query('limit') limit?: string,
    @Query('level') level?: string,
    @Query('text') text?: string,
    @Query('instance') instance?: string,
  ) {
    return this.service.getDeploymentTargetLogs(
      projectId,
      targetId,
      req.session.user!.id,
      parseDeploymentLogsQuery({
        type,
        startTime,
        endTime,
        direction,
        limit,
        level,
        text,
        instance,
      }),
    );
  }

  /**
   * Live-tail. Two modes share one endpoint:
   *
   * - No `mode` (default): TODAY's behaviour, unchanged for the existing
   *   Hosting console - pushes the full log snapshot (same shape as GET
   *   .../logs) on every poll tick rather than an incremental diff.
   * - `mode=append`: sends one snapshot (newest page, backward), then - unless
   *   endTime closed the window - only the lines newer than the last one sent.
   *
   * Neither mode polls the provider itself: both go through
   * DeploymentLogsHubService, which shares one provider read per target per
   * interval between every open console and pauses all of them while the
   * provider's rate limit is in force. A 429 is reported as an event
   * (`rateLimited: true`, `retryAfterMs`) and the stream carries on.
   */
  @Sse(':targetId/logs/stream')
  logsStream(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('targetId') targetId: string,
    @Query('mode') mode?: string,
    @Query('type') type?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('level') level?: string,
    @Query('text') text?: string,
    @Query('instance') instance?: string,
  ): Observable<MessageEvent> {
    const userId = req.session.user!.id;
    const filters = parseDeploymentLogsQuery({
      type,
      startTime,
      endTime,
      // The stream picks direction/limit itself (backward for the snapshot,
      // forward for each tail tick) - not caller-controllable here.
      direction: undefined,
      limit: undefined,
      level,
      text,
      instance,
    });

    // Access is checked once per subscriber, here, so a viewer who cannot see
    // the target never attaches to a poller another viewer started.
    const reader$ = defer(() =>
      this.service.openLogsReader(projectId, targetId, userId),
    );

    if (mode === 'append') {
      return reader$.pipe(
        switchMap((reader) => this.logsHub.appendStream(reader, filters)),
        map((data) => ({ data }) as MessageEvent),
        catchError((error: unknown) =>
          of({
            data: {
              kind: 'status' as const,
              source: 'unavailable' as const,
              reason: error instanceof Error ? error.message : String(error),
            },
          } as MessageEvent),
        ),
      );
    }

    return reader$.pipe(
      switchMap((reader) => this.logsHub.legacyStream(reader, filters)),
      map((data) => ({ data }) as MessageEvent),
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
