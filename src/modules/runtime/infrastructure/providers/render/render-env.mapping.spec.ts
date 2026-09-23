import {
  buildRenderLogsQueryParams,
  mapRenderLogLine,
  mapRenderLogsPage,
  readCreatedService,
  readServiceStatus,
} from './render-env.mapping';

describe('readCreatedService', () => {
  it.each([
    {
      name: 'nested service id/name and serviceDetails.url',
      payload: {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested.onrender.com',
      },
    },
    {
      name: 'nested service details.url',
      payload: {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          details: { url: 'https://nested-details.onrender.com' },
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested-details.onrender.com',
      },
    },
    {
      name: 'nested service.url',
      payload: {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          url: 'https://nested-url.onrender.com',
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested-url.onrender.com',
      },
    },
    {
      name: 'flat id/name/url',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
      },
      expected: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
      },
    },
    {
      name: 'flat serviceDetails.url',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        serviceDetails: { url: 'https://flat-sd.onrender.com' },
      },
      expected: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat-sd.onrender.com',
      },
    },
    {
      name: 'flat details.url',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        details: { url: 'https://flat-details.onrender.com' },
      },
      expected: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat-details.onrender.com',
      },
    },
    {
      name: 'nested id/name preferred over flat id/name',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested.onrender.com',
      },
    },
    {
      name: 'missing url as null',
      payload: { id: 'srv-1', name: 'api' },
      expected: { id: 'srv-1', name: 'api', url: null },
    },
  ])('reads $name', ({ payload, expected }) => {
    expect(readCreatedService(payload)).toEqual(expected);
  });

  it('returns null when id or name is missing', () => {
    expect(readCreatedService({ service: {} })).toBeNull();
    expect(readCreatedService({ id: 'srv-1' })).toBeNull();
    expect(readCreatedService({ name: 'only-name' })).toBeNull();
  });
});

describe('readServiceStatus', () => {
  it.each([
    {
      name: 'nested url/suspended/ownerId',
      payload: {
        service: {
          suspended: 'not_suspended',
          ownerId: 'tea-nested',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      expected: {
        url: 'https://nested.onrender.com',
        state: 'not_suspended',
        ownerId: 'tea-nested',
      },
    },
    {
      name: 'flat url/suspended/ownerId',
      payload: {
        suspended: 'suspended',
        ownerId: 'tea-flat',
        url: 'https://flat.onrender.com',
      },
      expected: {
        url: 'https://flat.onrender.com',
        state: 'suspended',
        ownerId: 'tea-flat',
      },
    },
    {
      name: 'nested details.url without owner or state',
      payload: {
        service: { details: { url: 'https://nested-details.onrender.com' } },
      },
      expected: { url: 'https://nested-details.onrender.com' },
    },
  ])('reads $name', ({ payload, expected }) => {
    expect(readServiceStatus(payload)).toEqual(expected);
  });
});

describe('mapRenderLogLine', () => {
  it('reads level/type/instance from labels — the fix for the old l.level bug', () => {
    const line = mapRenderLogLine({
      id: 'log-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      message: 'listening on 10000',
      labels: [
        { name: 'level', value: 'warning' },
        { name: 'type', value: 'app' },
        { name: 'instance', value: 'srv-abc123' },
      ],
    });

    expect(line).toEqual({
      id: 'log-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      message: 'listening on 10000',
      level: 'warn',
      type: 'app',
      instance: 'srv-abc123',
      labels: {
        level: 'warning',
        type: 'app',
        instance: 'srv-abc123',
      },
    });
  });

  it('normalises error/fatal/critical and debug/trace level labels', () => {
    expect(
      mapRenderLogLine({ labels: [{ name: 'level', value: 'fatal' }] }).level,
    ).toBe('error');
    expect(
      mapRenderLogLine({ labels: [{ name: 'level', value: 'critical' }] })
        .level,
    ).toBe('error');
    expect(
      mapRenderLogLine({ labels: [{ name: 'level', value: 'trace' }] }).level,
    ).toBe('debug');
  });

  it('defaults to info level and null type/instance with no labels', () => {
    const line = mapRenderLogLine({
      id: 'log-2',
      timestamp: '2026-07-12T00:00:00.000Z',
      message: 'plain line',
    });

    expect(line.level).toBe('info');
    expect(line.type).toBeNull();
    expect(line.instance).toBeNull();
    expect(line.labels).toEqual({});
  });

  it('treats an unrecognised type label as null rather than passing it through', () => {
    const line = mapRenderLogLine({
      labels: [{ name: 'type', value: 'metrics' }],
    });

    expect(line.type).toBeNull();
    // The raw label is still preserved for parity/debug.
    expect(line.labels['type']).toBe('metrics');
  });
});

describe('mapRenderLogsPage', () => {
  it('sorts lines oldest -> newest regardless of the order Render returned them in', () => {
    const page = mapRenderLogsPage({
      hasMore: false,
      logs: [
        {
          id: 'newest',
          timestamp: '2026-07-12T00:00:02.000Z',
          message: 'later',
        },
        {
          id: 'oldest',
          timestamp: '2026-07-12T00:00:00.000Z',
          message: 'earlier',
        },
        {
          id: 'middle',
          timestamp: '2026-07-12T00:00:01.000Z',
          message: 'between',
        },
      ],
    });

    expect(page.logs.map((line) => line.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('recovers true emission order for backward lines tied at the same millisecond', () => {
    // Date.parse only resolves to millisecond precision, and Array.sort is
    // stable, so three lines sharing one timestamp would otherwise keep
    // whatever order the payload arrived in. For direction: 'backward',
    // Render fills newest-first, so the payload lists the actual-newest
    // line ('c', e.g. the last stack-trace frame logged) first and the
    // actual-oldest ('a', e.g. the thrown error) last — the opposite of
    // true emission order.
    const tiedTimestamp = '2026-07-12T00:00:00.123Z';
    const page = mapRenderLogsPage(
      {
        logs: [
          {
            id: 'c',
            timestamp: tiedTimestamp,
            message: 'at inner (file.js:3)',
          },
          {
            id: 'b',
            timestamp: tiedTimestamp,
            message: 'at outer (file.js:1)',
          },
          { id: 'a', timestamp: tiedTimestamp, message: 'TypeError: boom' },
        ],
      },
      'backward',
    );

    expect(page.logs.map((line) => line.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves forward lines tied at the same millisecond in the order Render sent them', () => {
    // Forward already fills oldest-first, so the payload already IS true
    // emission order and must not be reversed.
    const tiedTimestamp = '2026-07-12T00:00:00.123Z';
    const page = mapRenderLogsPage(
      {
        logs: [
          { id: 'a', timestamp: tiedTimestamp, message: 'TypeError: boom' },
          {
            id: 'b',
            timestamp: tiedTimestamp,
            message: 'at outer (file.js:1)',
          },
          {
            id: 'c',
            timestamp: tiedTimestamp,
            message: 'at inner (file.js:3)',
          },
        ],
      },
      'forward',
    );

    expect(page.logs.map((line) => line.id)).toEqual(['a', 'b', 'c']);
  });

  it('still sorts mixed, distinct timestamps ascending for a backward page', () => {
    const page = mapRenderLogsPage(
      {
        logs: [
          {
            id: 'newest',
            timestamp: '2026-07-12T00:00:02.000Z',
            message: 'later',
          },
          {
            id: 'middle',
            timestamp: '2026-07-12T00:00:01.000Z',
            message: 'between',
          },
          {
            id: 'oldest',
            timestamp: '2026-07-12T00:00:00.000Z',
            message: 'earlier',
          },
        ],
      },
      'backward',
    );

    expect(page.logs.map((line) => line.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ]);
  });

  it('maps hasMore and the next window straight through', () => {
    const page = mapRenderLogsPage({
      hasMore: true,
      nextStartTime: '2026-07-12T00:00:02.000Z',
      nextEndTime: '2026-07-12T01:00:00.000Z',
      logs: [],
    });

    expect(page.hasMore).toBe(true);
    expect(page.next).toEqual({
      startTime: '2026-07-12T00:00:02.000Z',
      endTime: '2026-07-12T01:00:00.000Z',
    });
  });

  it('reports no next window when Render omits the cursor fields', () => {
    const page = mapRenderLogsPage({ logs: [] });

    expect(page.hasMore).toBe(false);
    expect(page.next).toBeNull();
  });
});

describe('buildRenderLogsQueryParams', () => {
  it('sends array filters as repeated params and includes the explicit window', () => {
    const params = buildRenderLogsQueryParams('owner-1', 'srv-1', {
      startTime: '2026-07-11T00:00:00.000Z',
      endTime: '2026-07-12T00:00:00.000Z',
      direction: 'forward',
      type: ['build', 'app'],
      level: ['error', 'warn'],
      instance: ['srv-abc', 'srv-def'],
      text: 'timeout',
    });

    expect(params.get('ownerId')).toBe('owner-1');
    expect(params.getAll('resource')).toEqual(['srv-1']);
    expect(params.get('startTime')).toBe('2026-07-11T00:00:00.000Z');
    expect(params.get('endTime')).toBe('2026-07-12T00:00:00.000Z');
    expect(params.get('direction')).toBe('forward');
    expect(params.getAll('type')).toEqual(['build', 'app']);
    expect(params.getAll('level')).toEqual(['error', 'warn']);
    expect(params.getAll('instance')).toEqual(['srv-abc', 'srv-def']);
    expect(params.get('text')).toBe('timeout');
  });

  it('defaults direction to backward and limit to 100 with no filters given', () => {
    const params = buildRenderLogsQueryParams('owner-1', 'srv-1', {});

    expect(params.get('direction')).toBe('backward');
    expect(params.get('limit')).toBe('100');
    expect(params.has('startTime')).toBe(false);
    expect(params.has('endTime')).toBe(false);
    expect(params.getAll('type')).toEqual([]);
  });

  it('clamps an out-of-range limit into the 1..100 contract', () => {
    expect(
      buildRenderLogsQueryParams('owner-1', 'srv-1', { limit: 500 }).get(
        'limit',
      ),
    ).toBe('100');
    expect(
      buildRenderLogsQueryParams('owner-1', 'srv-1', { limit: 0 }).get('limit'),
    ).toBe('1');
  });
});
