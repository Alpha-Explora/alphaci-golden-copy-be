import {
  applyDecorators,
  Injectable,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  Throttle,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { OnpremHostsService } from '../application/onprem/onprem-hosts.service';

/**
 * Requests one machine may make to each agent endpoint per minute. A supervisor
 * on its 30-second timer sends two heartbeats and two assignment polls a minute;
 * each deployment status report adds one more. The headroom absorbs bursts and
 * retries, and still stops one machine from flooding the API.
 */
export const ONPREM_MACHINE_RATE_LIMIT = { limit: 120, ttl: 60_000 };

const MACHINE_CREDENTIAL_ROUTE = 'onprem:machine-credential-route';

/**
 * Marks an agent endpoint that authenticates with a machine credential. Its
 * limit is keyed on the machine rather than the client IP, so machines behind
 * one NAT do not share a bucket.
 */
export const OnpremMachineRateLimit = () =>
  applyDecorators(
    Throttle({ default: ONPREM_MACHINE_RATE_LIMIT }),
    SetMetadata(MACHINE_CREDENTIAL_ROUTE, true),
  );

/**
 * The app-wide throttler. Machine-credential routes are keyed on the machine the
 * credential belongs to; every other route, including unauthenticated
 * enrollment, stays keyed on the client IP. A credential that is unknown or
 * revoked falls back to its IP, so random tokens cannot open fresh buckets.
 */
@Injectable()
export class OnpremMachineThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly hosts: OnpremHostsService,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(
    req: Request,
    context?: ExecutionContext,
  ): Promise<string> {
    const ip = req.ip ?? '';
    const machineRoute =
      !!context &&
      this.reflector.getAllAndOverride<boolean>(MACHINE_CREDENTIAL_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]);
    if (!machineRoute) return ip;
    const machineId = await this.hosts.machineIdForCredential(
      bearerCredential(req.headers.authorization),
    );
    return machineId ? `machine:${machineId}` : ip;
  }
}

function bearerCredential(authorization: string | undefined): string | null {
  return /^bearer (\S+)$/i.exec(authorization ?? '')?.[1] ?? null;
}
