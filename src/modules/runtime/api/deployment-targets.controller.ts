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
import {
  EMPTY,
  Observable,
  catchError,
  concat,
  defer,
  interval,
  map,
  of,
  startWith,
  switchMap,
} from 'rxjs';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CapabilityGuard } from '#kernel/composition/capability.guard';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator';
import type { CreateDeploymentTargetDto } from './dto/create-deployment-target.dto';
import type { DetachDeploymentTargetDto } from './dto/detach-deployment-target.dto';
import { DeploymentTargetsService } from '../application/deployment-targets.service';
import type { UpdateDeploymentTargetMetadataInput } from '../core/deployments.types';
import type {
  DeploymentLogLine,
  DeploymentLogsQuery,
  DeploymentLogsResponse,
} from '../core/deployment-logs.types';
import {
  advanceAppendCursor,
  parseDeploymentLogsQuery,
  type AppendCursor,
} from './deployment-logs-stream.util';

const LOG_STREAM_POLL_INTERVAL_MS = 5_000;

/** Bounds one append tick's forward paging so a slow/chatty deployment can never make one tick run away. */
const APPEND_TICK_PAGE_CAP = 5;

@Controller('projects/:projectId/deployment-targets')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
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
   *   Hosting console — pushes the full log snapshot (same shape as GET
   *   .../logs) on every poll tick rather than an incremental diff.
   * - `mode=append`: sends one snapshot (newest page, backward) covering
   *   [startTime, endTime ?? now], then — unless endTime closed the window —
   *   polls forward from the newest line already sent and emits only the
   *   new lines each tick. See appendLogsStream for the paging/dedupe
   *   details.
   *
   * Both modes poll at the same cadence, so this doesn't increase load on
   * Render/Vercel over the old behaviour — it only moves who initiates the
   * request.
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
      // forward for each tail tick) — not caller-controllable here.
      direction: undefined,
      limit: undefined,
      level,
      text,
      instance,
    });

    if (mode === 'append') {
      return this.appendLogsStream(projectId, targetId, userId, filters);
    }

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

  /**
   * `mode=append`'s stream. A closed window (explicit endTime) sends one
   * snapshot and completes — that is a bounded historical read, not a tail.
   * An open window keeps polling forward from the snapshot's newest
   * timestamp, capping each tick at APPEND_TICK_PAGE_CAP provider pages so a
   * very chatty deployment can never make one tick run away, and only
   * emitting an 'append' event when a tick actually turned up new lines.
   */
  private appendLogsStream(
    projectId: string,
    targetId: string,
    userId: string,
    filters: DeploymentLogsQuery,
  ): Observable<MessageEvent> {
    const closedWindow = Boolean(filters.endTime);
    const snapshotEndTime = filters.endTime ?? new Date().toISOString();

    const snapshot$ = defer(() =>
      this.service.getDeploymentTargetLogs(projectId, targetId, userId, {
        ...filters,
        endTime: snapshotEndTime,
        direction: 'backward',
        limit: 100,
      }),
    ).pipe(
      map((snapshot) => ({
        event: {
          data: { kind: 'snapshot' as const, ...snapshot },
        } as MessageEvent,
        // Seed the tail cursor from the snapshot without treating any of its
        // lines as "appended" — the snapshot event already carried them.
        cursor: advanceAppendCursor(null, snapshot.logs).cursor,
      })),
    );

    return snapshot$.pipe(
      switchMap(({ event, cursor: initialCursor }) => {
        if (closedWindow) {
          return of(event);
        }

        let cursor = initialCursor;

        return concat(
          of(event),
          interval(LOG_STREAM_POLL_INTERVAL_MS).pipe(
            switchMap(() =>
              defer(() =>
                this.runAppendTick(
                  projectId,
                  targetId,
                  userId,
                  filters,
                  cursor,
                ),
              ),
            ),
            map((tick) => {
              cursor = tick.cursor;
              return tick.event;
            }),
            switchMap((tickEvent) =>
              tickEvent ? of(tickEvent) : (EMPTY as Observable<MessageEvent>),
            ),
          ),
        );
      }),
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

  /**
   * One append-mode poll tick: pages forward from `cursor` at most
   * APPEND_TICK_PAGE_CAP times (following `hasMore`), folding each page
   * through advanceAppendCursor to drop lines already sent at the boundary
   * timestamp. A provider failure — whether returned as `source:
   * 'unavailable'` or thrown — stops paging for this tick and reports a
   * `status` event instead; the outer interval keeps ticking regardless, so
   * the stream self-heals once the provider recovers.
   */
  private async runAppendTick(
    projectId: string,
    targetId: string,
    userId: string,
    filters: DeploymentLogsQuery,
    cursor: AppendCursor | null,
  ): Promise<{ cursor: AppendCursor | null; event: MessageEvent | null }> {
    let workingCursor = cursor;
    let startTime = cursor?.time ?? new Date().toISOString();
    let more = true;
    let pages = 0;
    const collected: DeploymentLogLine[] = [];
    let lastSource: DeploymentLogsResponse['source'] = 'live';
    // Tail ticks always query an open forward window from the cursor to
    // "now" - startTime/endTime/direction/limit are set per-page below, so
    // only the content filters carry over from the stream's own query.
    const tickFilters: DeploymentLogsQuery = {
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.level ? { level: filters.level } : {}),
      ...(filters.text ? { text: filters.text } : {}),
      ...(filters.instance ? { instance: filters.instance } : {}),
    };

    while (more && pages < APPEND_TICK_PAGE_CAP) {
      pages += 1;
      let page: DeploymentLogsResponse;
      try {
        page = await this.service.getDeploymentTargetLogs(
          projectId,
          targetId,
          userId,
          {
            ...tickFilters,
            startTime,
            direction: 'forward',
            limit: 100,
          },
        );
      } catch (err) {
        return {
          cursor: workingCursor,
          event: {
            data: {
              kind: 'status',
              source: 'unavailable',
              reason: err instanceof Error ? err.message : String(err),
            },
          } as MessageEvent,
        };
      }

      lastSource = page.source;
      if (page.source === 'unavailable') {
        return {
          cursor: workingCursor,
          event: {
            data: { kind: 'status', source: page.source, reason: page.reason },
          } as MessageEvent,
        };
      }

      const { cursor: nextCursor, appended } = advanceAppendCursor(
        workingCursor,
        page.logs,
      );
      workingCursor = nextCursor;
      collected.push(...appended);
      if (nextCursor) {
        startTime = nextCursor.time;
      }
      more = page.hasMore;
    }

    if (collected.length === 0) {
      return { cursor: workingCursor, event: null };
    }

    return {
      cursor: workingCursor,
      event: {
        data: { kind: 'append', source: lastSource, logs: collected },
      } as MessageEvent,
    };
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
