import { Injectable, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import {
  hashMachineSecret,
  MACHINE_TOKEN_PREFIX,
  OnpremHostsService,
} from '../application/onprem/onprem-hosts.service';

/**
 * Requests one machine may make to each agent endpoint per minute. A supervisor
 * on its 30-second timer sends two heartbeats and two assignment polls a minute;
 * each deployment status report adds one more. The headroom absorbs bursts and
 * retries, and still stops one machine from flooding the API.
 */
export const ONPREM_MACHINE_RATE_LIMIT = { limit: 120, ttl: 60_000 };
/**
 * Requests one client address may make to each agent endpoint per minute, from
 * any credential. Only requests that need a credential lookup count, so one
 * machine's rejected traffic cannot use up its NAT neighbours' allowance. The
 * cap bounds the lookup and handler work a flood can cause.
 */
export const ONPREM_AGENT_IP_RATE_LIMIT = { limit: 300, ttl: 60_000 };
/**
 * Lookups one client address may make per minute that find no machine. Once it
 * is spent, the address is no longer looked up at all.
 */
export const FAILED_LOOKUP_BUDGET = 30;
/** How long a verified credential keeps its machine id. */
const VERIFIED_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 10_000;

const MACHINE_CREDENTIAL_ROUTE = 'onprem:machine-credential-route';
const reflector = new Reflector();

export const ONPREM_AGENT_IP_THROTTLER = 'onprem-agent-ip';
export const ONPREM_MACHINE_THROTTLER = 'onprem-machine';

/** Whether a handler is an agent endpoint that authenticates with a machine credential. */
export function isOnpremMachineRoute(context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(MACHINE_CREDENTIAL_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]) ?? false
  );
}

/**
 * Named throttlers for agent endpoints, registered with the app's throttler
 * module. The order is significant: the per-address cap runs before the machine
 * bucket, which is the step that needs a credential lookup. Both apply only to
 * machine-credential routes; every other route keeps the default throttler.
 */
export const ONPREM_AGENT_THROTTLERS: ThrottlerOptions[] = [
  {
    name: ONPREM_AGENT_IP_THROTTLER,
    ...ONPREM_AGENT_IP_RATE_LIMIT,
    getTracker: (req) => (req as Request).ip ?? '',
    skipIf: (context) => !isOnpremMachineRoute(context),
  },
  {
    name: ONPREM_MACHINE_THROTTLER,
    ...ONPREM_MACHINE_RATE_LIMIT,
    skipIf: (context) => !isOnpremMachineRoute(context),
  },
];

/**
 * Marks an agent endpoint that authenticates with a machine credential. Its
 * requests are counted per machine by ONPREM_MACHINE_THROTTLER, not per client IP.
 */
export const OnpremMachineRateLimit = () =>
  SetMetadata(MACHINE_CREDENTIAL_ROUTE, true);

/**
 * The app-wide throttler. A machine-credential route is keyed on the machine the
 * credential verifiably belongs to. Anything else, including an unknown or
 * revoked credential, is keyed on the client IP, so random tokens cannot open
 * fresh buckets. Verified machine ids are cached for a minute, so an agent costs
 * one lookup a minute. Requests served from a live cache entry do not count
 * against the address cap. Each address gets a small budget of lookups that find
 * no machine. Once that is spent, only an already verified machine keeps its own
 * bucket, and anything else is keyed on the address.
 *
 * The cache only chooses a bucket. Authorization stays with the handler, which
 * checks the credential inside its own transaction, so a stale entry can only
 * count a revoked machine's requests against that machine's bucket.
 */
@Injectable()
export class OnpremMachineThrottlerGuard extends ThrottlerGuard {
  private readonly verified = new Map<
    string,
    { machineId: string; expiresAt: number }
  >();
  private readonly failedLookups = new Map<
    string,
    { count: number; resetsAt: number }
  >();

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly hosts: OnpremHostsService,
  ) {
    super(options, storage, reflector);
  }

  protected override async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    // A request a live verified machine serves needs no lookup, so it does not
    // spend the address cap that protects lookups from a flood.
    if (
      requestProps.throttler.name === ONPREM_AGENT_IP_THROTTLER &&
      isOnpremMachineRoute(requestProps.context)
    ) {
      const req = requestProps.context.switchToHttp().getRequest<Request>();
      const credential = bearerCredential(req.headers.authorization);
      if (credential && this.liveMachineId(credential)) return true;
    }
    return super.handleRequest(requestProps);
  }

  protected override async getTracker(
    req: Request,
    context?: ExecutionContext,
  ): Promise<string> {
    const ip = req.ip ?? '';
    if (!context || !isOnpremMachineRoute(context)) return ip;
    const machineId = await this.machineFor(
      ip,
      bearerCredential(req.headers.authorization),
    );
    return machineId ? `machine:${machineId}` : ip;
  }

  /** The verified machine for a credential whose cache entry is still live. */
  private liveMachineId(credential: string): string | null {
    const entry = this.verified.get(hashMachineSecret(credential));
    return entry && entry.expiresAt > performance.now()
      ? entry.machineId
      : null;
  }

  private async machineFor(
    ip: string,
    credential: string | null,
  ): Promise<string | null> {
    // Only machine credentials can be looked up; anything else is keyed on the address.
    if (!credential?.startsWith(MACHINE_TOKEN_PREFIX)) return null;
    const key = hashMachineSecret(credential);
    const now = performance.now();
    const verified = this.verified.get(key);
    if (verified && verified.expiresAt > now) return verified.machineId;
    const failures = this.failedLookups.get(ip);
    if (
      failures &&
      failures.resetsAt > now &&
      failures.count >= FAILED_LOOKUP_BUDGET
    )
      // The budget is spent: a machine verified earlier keeps its own bucket.
      return verified?.machineId ?? null;
    const machineId = await this.hosts.machineIdForCredential(credential);
    if (machineId) {
      boundedSet(this.verified, key, {
        machineId,
        expiresAt: now + VERIFIED_TTL_MS,
      });
    } else {
      // The lookup found no live machine, so an earlier verification no longer
      // holds: a revoked machine must not keep its own bucket through the fallback.
      this.verified.delete(key);
      if (!failures || failures.resetsAt <= now) {
        boundedSet(this.failedLookups, ip, {
          count: 1,
          resetsAt: now + 60_000,
        });
      } else {
        failures.count += 1;
      }
    }
    return machineId;
  }
}

function bearerCredential(authorization: string | undefined): string | null {
  return /^bearer (\S+)$/i.exec(authorization ?? '')?.[1] ?? null;
}

/** Sets an entry and evicts the oldest one when the map is full. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}
