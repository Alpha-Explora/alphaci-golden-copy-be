import type { DeploymentLogLine } from '../core/deployment-logs.types';
import {
  advanceAppendCursor,
  parseDeploymentLogsQuery,
} from './deployment-logs-stream.util';

function makeLine(overrides: Partial<DeploymentLogLine>): DeploymentLogLine {
  return {
    id: 'id-1',
    timestamp: '2026-07-12T00:00:00.000Z',
    message: 'line',
    level: 'info',
    type: null,
    instance: null,
    labels: {},
    ...overrides,
  };
}

describe('advanceAppendCursor', () => {
  it('seeds a cursor from the last line; callers seeding from a snapshot discard `appended` themselves', () => {
    const logs = [
      makeLine({ id: 'a', timestamp: '2026-07-12T00:00:00.000Z' }),
      makeLine({ id: 'b', timestamp: '2026-07-12T00:00:01.000Z' }),
    ];

    const { cursor, appended } = advanceAppendCursor(null, logs);

    expect(cursor).toEqual({
      time: '2026-07-12T00:00:01.000Z',
      idsAtTime: new Set(['b']),
    });
    // Every line differs from a null cursor, so all of them come back as
    // "appended" here — the snapshot call site (deployment-targets.controller
    // ts) discards this and keeps only `cursor`, since the snapshot event
    // already carried these lines.
    expect(appended).toEqual(logs);
  });

  it('returns the unchanged cursor when seeding from an empty page', () => {
    const { cursor, appended } = advanceAppendCursor(null, []);

    expect(cursor).toBeNull();
    expect(appended).toEqual([]);
  });

  it('reports every line strictly newer than the cursor as appended', () => {
    const cursor = {
      time: '2026-07-12T00:00:01.000Z',
      idsAtTime: new Set(['b']),
    };
    const logs = [makeLine({ id: 'c', timestamp: '2026-07-12T00:00:02.000Z' })];

    const { cursor: next, appended } = advanceAppendCursor(cursor, logs);

    expect(appended).toEqual(logs);
    expect(next).toEqual({
      time: '2026-07-12T00:00:02.000Z',
      idsAtTime: new Set(['c']),
    });
  });

  it('drops a line at the exact boundary timestamp already seen', () => {
    const cursor = {
      time: '2026-07-12T00:00:01.000Z',
      idsAtTime: new Set(['b']),
    };
    // A forward query starting at the cursor's own timestamp re-includes the
    // line already sent at that timestamp — this must not be re-appended.
    const logs = [
      makeLine({ id: 'b', timestamp: '2026-07-12T00:00:01.000Z' }),
      makeLine({ id: 'c', timestamp: '2026-07-12T00:00:02.000Z' }),
    ];

    const { cursor: next, appended } = advanceAppendCursor(cursor, logs);

    expect(appended.map((l) => l.id)).toEqual(['c']);
    expect(next).toEqual({
      time: '2026-07-12T00:00:02.000Z',
      idsAtTime: new Set(['c']),
    });
  });

  it('accumulates ids sharing the same boundary timestamp across calls', () => {
    const cursor = {
      time: '2026-07-12T00:00:01.000Z',
      idsAtTime: new Set(['b']),
    };
    // Two distinct lines land on the same millisecond as the cursor — both
    // are genuinely new and neither collides with the other's id.
    const logs = [
      makeLine({ id: 'b', timestamp: '2026-07-12T00:00:01.000Z' }),
      makeLine({ id: 'b2', timestamp: '2026-07-12T00:00:01.000Z' }),
    ];

    const { cursor: next, appended } = advanceAppendCursor(cursor, logs);

    expect(appended.map((l) => l.id)).toEqual(['b2']);
    expect(next).toEqual({
      time: '2026-07-12T00:00:01.000Z',
      idsAtTime: new Set(['b', 'b2']),
    });
  });

  it('returns an equivalent cursor when a page has no new lines', () => {
    const cursor = {
      time: '2026-07-12T00:00:01.000Z',
      idsAtTime: new Set(['b']),
    };

    const { cursor: next, appended } = advanceAppendCursor(cursor, []);

    expect(next).toEqual(cursor);
    expect(appended).toEqual([]);
  });
});

describe('parseDeploymentLogsQuery', () => {
  const empty = {
    startTime: undefined,
    endTime: undefined,
    direction: undefined,
    limit: undefined,
    type: undefined,
    level: undefined,
    text: undefined,
    instance: undefined,
  };

  it('returns an empty query when nothing is provided', () => {
    expect(parseDeploymentLogsQuery(empty)).toEqual({});
  });

  it('splits comma lists and trims whitespace', () => {
    expect(
      parseDeploymentLogsQuery({ ...empty, type: ' build , app ,' }),
    ).toEqual({ type: ['build', 'app'] });
  });

  it('only accepts "forward" as an explicit direction, defaulting otherwise', () => {
    expect(
      parseDeploymentLogsQuery({ ...empty, direction: 'forward' }),
    ).toEqual({ direction: 'forward' });
    expect(
      parseDeploymentLogsQuery({ ...empty, direction: 'sideways' }),
    ).toEqual({});
  });

  it('clamps an out-of-range limit', () => {
    expect(parseDeploymentLogsQuery({ ...empty, limit: '500' })).toEqual({
      limit: 100,
    });
    expect(parseDeploymentLogsQuery({ ...empty, limit: '0' })).toEqual({
      limit: 1,
    });
  });

  it('ignores a non-numeric limit', () => {
    expect(parseDeploymentLogsQuery({ ...empty, limit: 'abc' })).toEqual({});
  });
});
