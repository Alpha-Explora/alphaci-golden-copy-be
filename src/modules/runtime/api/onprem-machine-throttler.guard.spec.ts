import { Controller, Post, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  Throttle,
  ThrottlerException,
  ThrottlerStorageService,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import type { OnpremHostsService } from '../application/onprem/onprem-hosts.service';
import {
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

const MACHINES: Record<string, string> = {
  onprem_machine_first: 'machine-1',
  onprem_machine_second: 'machine-2',
};
const CLIENT_IP = '203.0.113.7';
const DEFAULT_LIMIT = 60;

describe('OnpremMachineThrottlerGuard', () => {
  let storage: ThrottlerStorageService;

  afterEach(() => {
    storage.onApplicationShutdown();
  });

  function setup() {
    storage = new ThrottlerStorageService();
    const options: ThrottlerModuleOptions = [
      { name: 'default', ttl: 60_000, limit: DEFAULT_LIMIT },
    ];
    const hosts = {
      machineIdForCredential: jest.fn(
        async (credential: string | null) =>
          (credential && MACHINES[credential]) || null,
      ),
    } as unknown as OnpremHostsService;
    const guard = new OnpremMachineThrottlerGuard(
      options,
      storage,
      new Reflector(),
      hosts,
    );
    return { guard, hosts };
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
    make: () => ExecutionContext,
  ) {
    for (let index = 0; index < count; index++)
      await expect(guard.canActivate(make())).resolves.toBe(true);
  }

  it('gives each machine its own bucket, even when they share an IP', async () => {
    const { guard } = setup();
    await guard.onModuleInit();
    const limit = ONPREM_MACHINE_RATE_LIMIT.limit;
    await spend(guard, limit, () =>
      call('heartbeat', 'Bearer onprem_machine_first'),
    );
    await expect(
      guard.canActivate(call('heartbeat', 'Bearer onprem_machine_first')),
    ).rejects.toThrow(ThrottlerException);
    await expect(
      guard.canActivate(call('heartbeat', 'Bearer onprem_machine_second')),
    ).resolves.toBe(true);
  });

  it('keys unknown or revoked credentials on the client IP', async () => {
    const { guard } = setup();
    await guard.onModuleInit();
    const limit = ONPREM_MACHINE_RATE_LIMIT.limit;
    // Rotating through made-up tokens must not earn a fresh bucket each time.
    await spend(guard, limit, () =>
      call('heartbeat', `Bearer onprem_machine_random${Math.random()}`),
    );
    await expect(
      guard.canActivate(call('heartbeat', 'Bearer onprem_machine_another')),
    ).rejects.toThrow(ThrottlerException);
  });

  it('keeps routes without a machine credential on the shared client IP', async () => {
    const { guard, hosts } = setup();
    await guard.onModuleInit();
    // Enrollment is unauthenticated: machines behind one NAT share the IP limit.
    await spend(guard, 5, () => call('enroll', undefined));
    await expect(guard.canActivate(call('enroll', undefined))).rejects.toThrow(
      ThrottlerException,
    );
    expect(hosts.machineIdForCredential).not.toHaveBeenCalled();
  });
});
