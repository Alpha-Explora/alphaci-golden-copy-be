import { Controller, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  Throttle,
  ThrottlerException,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { FixedWindowThrottlerStorage } from '#kernel/http/throttling/fixed-window-throttler.storage';
import type { OnpremHostsService } from '../application/onprem/onprem-hosts.service';
import {
  isOnpremMachineRoute,
  ONPREM_AGENT_IP_RATE_LIMIT,
  ONPREM_AGENT_THROTTLERS,
  ONPREM_MACHINE_RATE_LIMIT,
  OnpremMachineRateLimit,
  OnpremMachineThrottlerGuard,
} from './onprem-machine-throttler.guard';

@Controller('onprem')
class AgentFixture {
  @Post('heartbeat')
  @OnpremMachineRateLimit()
  heartbeat() {}

  @Post('enroll')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  enroll() {}
}

const CLIENT_IP = '203.0.113.7';
const DEFAULT_LIMIT = 60;

/** Credentials containing "known" belong to a machine; the rest do not. */
function hostsFake() {
  const machineIdForCredential = jest.fn(async (credential: string | null) =>
    credential?.includes('known') ? `machine-${credential}` : null,
  );
  return {
    machineIdForCredential,
    hosts: { machineIdForCredential } as unknown as OnpremHostsService,
  };
}

function setup() {
  const { hosts, machineIdForCredential } = hostsFake();
  const storage = new FixedWindowThrottlerStorage();
  const options: ThrottlerModuleOptions = {
    throttlers: [
      {
        name: 'default',
        ttl: 60_000,
        limit: DEFAULT_LIMIT,
        skipIf: isOnpremMachineRoute,
      },
      ...ONPREM_AGENT_THROTTLERS,
    ],
  };
  const guard = new OnpremMachineThrottlerGuard(
    options,
    storage,
    new Reflector(),
    hosts,
  );
  return { guard, machineIdForCredential };
}

/** A request context for one handler, as Nest builds it for an HTTP call. */
function call(
  handler: keyof AgentFixture,
  authorization?: string,
  ip = CLIENT_IP,
): ExecutionContext {
  const req = { ip, headers: authorization ? { authorization } : {} };
  const res = { header: jest.fn() };
  return {
    getHandler: () => AgentFixture.prototype[handler],
    getClass: () => AgentFixture,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

async function spend(
  guard: OnpremMachineThrottlerGuard,
  count: number,
  make: (index: number) => ExecutionContext,
) {
  for (let index = 0; index < count; index++)
    await expect(guard.canActivate(make(index))).resolves.toBe(true);
}

describe('OnpremMachineThrottlerGuard', () => {
  it('gives each machine its own bucket, even when they share an IP', async () => {
    const { guard } = setup();
    await guard.onModuleInit();
    const first = 'Bearer onprem_machine_known_first';
    const second = 'Bearer onprem_machine_known_second';
    await spend(guard, ONPREM_MACHINE_RATE_LIMIT.limit, () =>
      call('heartbeat', first),
    );
    await expect(guard.canActivate(call('heartbeat', first))).rejects.toThrow(
      ThrottlerException,
    );
    await expect(guard.canActivate(call('heartbeat', second))).resolves.toBe(
      true,
    );
  });

  it('looks a verified credential up once and then serves it from memory', async () => {
    const { guard, machineIdForCredential } = setup();
    await guard.onModuleInit();
    await spend(guard, 3, () =>
      call('heartbeat', 'Bearer onprem_machine_known_cached'),
    );
    expect(machineIdForCredential).toHaveBeenCalledTimes(1);
  });

  it('keys unknown credentials on the client IP and stops looking them up past the failed-lookup budget', async () => {
    const { guard, machineIdForCredential } = setup();
    await guard.onModuleInit();
    const unknown = (index: number) =>
      call('heartbeat', `Bearer onprem_machine_random${index}`);
    await spend(guard, ONPREM_MACHINE_RATE_LIMIT.limit, unknown);
    // Only the first 30 misses reach the database; the rest share the IP bucket.
    expect(machineIdForCredential).toHaveBeenCalledTimes(30);
    await expect(
      guard.canActivate(call('heartbeat', 'Bearer onprem_machine_another')),
    ).rejects.toThrow(ThrottlerException);
    expect(machineIdForCredential).toHaveBeenCalledTimes(30);
  });

  it('checks the per-address cap before it looks any credential up', async () => {
    const { guard, machineIdForCredential } = setup();
    await guard.onModuleInit();
    // Distinct machines, so each is looked up once and none is blocked itself.
    await spend(guard, ONPREM_AGENT_IP_RATE_LIMIT.limit, (index) =>
      call('heartbeat', `Bearer onprem_machine_known_${index}`),
    );
    const lookups = machineIdForCredential.mock.calls.length;
    await expect(
      guard.canActivate(call('heartbeat', 'Bearer onprem_machine_known_over')),
    ).rejects.toThrow(ThrottlerException);
    expect(machineIdForCredential).toHaveBeenCalledTimes(lookups);
  });

  it('keeps routes without a machine credential on the client IP', async () => {
    const { guard, machineIdForCredential } = setup();
    await guard.onModuleInit();
    await spend(guard, 5, () => call('enroll', undefined));
    await expect(guard.canActivate(call('enroll', undefined))).rejects.toThrow(
      ThrottlerException,
    );
    expect(machineIdForCredential).not.toHaveBeenCalled();
  });
});
