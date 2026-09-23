import {
  filterVercelLogLines,
  mapVercelBuildEventLine,
  mapVercelDeployEvent,
  mapVercelDeployHistory,
  mapVercelRuntimeLogLine,
} from './vercel-env.mapping';

describe('mapVercelDeployEvent', () => {
  it.each([
    ['production', 'production'],
    ['preview', 'preview'],
    ['staging', 'preview'],
    [null, 'preview'],
  ] as const)('maps target %p to environment %p', (target, environment) => {
    expect(
      mapVercelDeployEvent({
        uid: 'dpl_1',
        target,
        createdAt: 1_752_313_500_000,
      }),
    ).toMatchObject({
      id: 'dpl_1',
      environment,
    });
  });

  it('maps a missing target to preview', () => {
    expect(
      mapVercelDeployEvent({
        uid: 'dpl_1',
        createdAt: 1_752_313_500_000,
      }),
    ).toMatchObject({
      id: 'dpl_1',
      environment: 'preview',
    });
  });

  it('returns null when uid is missing', () => {
    expect(
      mapVercelDeployEvent({
        readyState: 'READY',
        createdAt: 1_752_313_500_000,
      }),
    ).toBeNull();
  });
});

describe('mapVercelDeployHistory', () => {
  it('drops rows without a uid and keeps production vs preview mapping', () => {
    expect(
      mapVercelDeployHistory([
        { readyState: 'READY', createdAt: 1_752_313_500_000 },
        {
          uid: 'dpl_prod',
          target: 'production',
          createdAt: 1_752_313_500_000,
        },
        {
          uid: 'dpl_preview',
          target: 'staging',
          createdAt: 1_752_313_500_000,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'dpl_prod',
        environment: 'production',
      }),
      expect.objectContaining({
        id: 'dpl_preview',
        environment: 'preview',
      }),
    ]);
  });
});

describe('mapVercelRuntimeLogLine', () => {
  it('maps a text/type entry into the shared log line shape', () => {
    const line = mapVercelRuntimeLogLine(
      {
        timestamp: 1_752_313_500_000,
        text: 'GET /api/health 200',
        type: 'stdout',
        requestId: 'req-1',
      },
      0,
    );

    expect(line).toEqual({
      id: 'req-1',
      timestamp: new Date(1_752_313_500_000).toISOString(),
      message: 'GET /api/health 200',
      level: 'info',
      type: 'app',
      instance: null,
      labels: { type: 'stdout' },
    });
  });

  it('maps an "err" stream type to error level', () => {
    expect(
      mapVercelRuntimeLogLine({ text: 'boom', type: 'err' }, 0).level,
    ).toBe('error');
  });

  it('maps a "warning" stream type to warn level', () => {
    expect(
      mapVercelRuntimeLogLine({ text: 'careful', type: 'warning' }, 0).level,
    ).toBe('warn');
  });

  it('prefers an explicit level over the stream type', () => {
    expect(
      mapVercelRuntimeLogLine({ text: 'x', type: 'err', level: 'debug' }, 0)
        .level,
    ).toBe('debug');
  });

  it('falls back to a positional id when neither id nor requestId is present', () => {
    const line = mapVercelRuntimeLogLine(
      { timestamp: 1_752_313_500_000, text: 'no id here' },
      3,
    );
    expect(line.id).toBe(
      `runtime-${new Date(1_752_313_500_000).toISOString()}-3`,
    );
  });
});

describe('mapVercelBuildEventLine', () => {
  it('maps a text build event into the shared log line shape', () => {
    const line = mapVercelBuildEventLine(
      {
        id: 'evt-1',
        created: 1_752_313_500_000,
        type: 'stdout',
        payload: { text: 'Building...' },
      },
      0,
    );

    expect(line).toEqual({
      id: 'evt-1',
      timestamp: new Date(1_752_313_500_000).toISOString(),
      message: 'Building...',
      level: 'info',
      type: 'build',
      instance: null,
      labels: { stream: 'stdout' },
    });
  });

  it('maps a stderr build event to error level', () => {
    const line = mapVercelBuildEventLine(
      {
        created: 1_752_313_500_000,
        type: 'stderr',
        payload: { text: 'failed' },
      },
      0,
    );
    expect(line?.level).toBe('error');
  });

  it('returns null for a structural event with no text payload', () => {
    expect(
      mapVercelBuildEventLine({ type: 'deployment-state', created: 1 }, 0),
    ).toBeNull();
  });
});

describe('filterVercelLogLines', () => {
  const lines = [
    mapVercelRuntimeLogLine({ text: 'all good', level: 'info' }, 0),
    mapVercelRuntimeLogLine({ text: 'connection timeout', level: 'error' }, 1),
    mapVercelRuntimeLogLine({ text: 'retrying request', level: 'warn' }, 2),
  ];

  it('filters by level, case-insensitively', () => {
    expect(
      filterVercelLogLines(lines, { level: ['ERROR'] }).map((l) => l.message),
    ).toEqual(['connection timeout']);
  });

  it('filters by a text substring, case-insensitively', () => {
    expect(
      filterVercelLogLines(lines, { text: 'TIMEOUT' }).map((l) => l.message),
    ).toEqual(['connection timeout']);
  });

  it('applies both filters together', () => {
    expect(
      filterVercelLogLines(lines, { level: ['warn'], text: 'retry' }).map(
        (l) => l.message,
      ),
    ).toEqual(['retrying request']);
  });

  it('returns every line unchanged when no filters are given', () => {
    expect(filterVercelLogLines(lines, {})).toEqual(lines);
  });
});
