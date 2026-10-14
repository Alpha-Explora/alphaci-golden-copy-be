import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { PlaywrightProgressBodyDto } from './playwright-progress.dto';
import { PLAYWRIGHT_LIVE_MAX_EVENTS_PER_BATCH } from '../../application/playwright-live.rules';

// The exact pipe main.ts installs globally.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const at = '2026-10-08T10:00:00.000Z';
const test = {
  id: 't1',
  file: 'a.spec.ts',
  title: 'works',
  project: 'chromium',
};

function body(events: unknown[], extra: Record<string, unknown> = {}) {
  return {
    repoFullName: 'Owner/repo',
    branch: 'uat',
    runId: 123456789,
    runAttempt: 1,
    commitSha: 'a'.repeat(40),
    events,
    ...extra,
  };
}

async function parse(value: unknown) {
  return pipe.transform(value, {
    type: 'body',
    metatype: PlaywrightProgressBodyDto,
  }) as Promise<PlaywrightProgressBodyDto>;
}

describe('PlaywrightProgressBodyDto', () => {
  it('accepts the four event types of the contract', async () => {
    const parsed = await parse(
      body([
        { type: 'run_started', at, total: 12 },
        { type: 'test_started', at, test },
        {
          type: 'test_finished',
          at,
          test: {
            ...test,
            status: 'passed',
            durationMs: 2100,
            retry: 0,
            error: null,
          },
        },
        {
          type: 'run_finished',
          at,
          status: 'failed',
          summary: {
            passed: 10,
            failed: 1,
            skipped: 1,
            flaky: 0,
            durationMs: 61000,
          },
        },
      ]),
    );
    expect(parsed.events.map((event) => event.type)).toEqual([
      'run_started',
      'test_started',
      'test_finished',
      'run_finished',
    ]);
  });

  it('allows error and retry to be omitted on a finished test', async () => {
    await expect(
      parse(
        body([
          {
            type: 'test_finished',
            at,
            test: { ...test, status: 'skipped', durationMs: 0 },
          },
        ]),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown event type with 400', async () => {
    await expect(
      parse(body([{ type: 'test_exploded', at }])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects undeclared fields at every level (forbidNonWhitelisted)', async () => {
    const cases = [
      body([{ type: 'run_started', at, total: 1 }], { extra: 1 }),
      body([{ type: 'run_started', at, total: 1, extra: 1 }]),
      body([{ type: 'test_started', at, test: { ...test, extra: 1 } }]),
      body([
        {
          type: 'run_finished',
          at,
          status: 'passed',
          summary: {
            passed: 1,
            failed: 0,
            skipped: 0,
            flaky: 0,
            durationMs: 1,
            extra: 1,
          },
        },
      ]),
    ];
    for (const value of cases) {
      await expect(parse(value)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects bad types and values', async () => {
    const cases = [
      body([{ type: 'run_started', at, total: '12' }]),
      body([{ type: 'run_started', at: 'yesterday', total: 1 }]),
      body([{ type: 'run_started', at, total: -1 }]),
      body([
        {
          type: 'test_finished',
          at,
          test: { ...test, status: 'exploded', durationMs: 1 },
        },
      ]),
      body([
        {
          type: 'test_finished',
          at,
          test: { ...test, status: 'passed', durationMs: 1.5 },
        },
      ]),
      body([
        {
          type: 'test_finished',
          at,
          test: {
            ...test,
            status: 'failed',
            durationMs: 1,
            error: 'x'.repeat(1001),
          },
        },
      ]),
      body([
        { type: 'test_started', at, test: { ...test, id: 'x'.repeat(301) } },
      ]),
      body([
        { type: 'test_started', at, test: { ...test, title: 'x'.repeat(301) } },
      ]),
      body([{ type: 'test_started', at }]),
      body([{ type: 'run_started', at, total: 1 }], { runId: '123' }),
      body([{ type: 'run_started', at, total: 1 }], { runAttempt: 0 }),
      body([{ type: 'run_started', at, total: 1 }], { commitSha: 'not-hex' }),
      body([{ type: 'run_started', at, total: 1 }], {
        repoFullName: 'no-slash',
      }),
      body([{ type: 'run_started', at, total: 1 }], { branch: 'bad branch' }),
    ];
    for (const value of cases) {
      await expect(parse(value)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('enforces 1..200 events per batch', async () => {
    await expect(parse(body([]))).rejects.toBeInstanceOf(BadRequestException);
    const event = { type: 'run_started', at, total: 1 };
    await expect(
      parse(
        body(
          Array.from(
            { length: PLAYWRIGHT_LIVE_MAX_EVENTS_PER_BATCH },
            () => event,
          ),
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      parse(
        body(
          Array.from(
            { length: PLAYWRIGHT_LIVE_MAX_EVENTS_PER_BATCH + 1 },
            () => event,
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
