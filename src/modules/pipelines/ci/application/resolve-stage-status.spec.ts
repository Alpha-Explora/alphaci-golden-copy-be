import {
  resolveOverallStatus,
  resolveStages,
  STALLED_AFTER_MS,
  type ReportedStage,
  type StageId,
} from './resolve-stage-status';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const minutesAgo = (n: number) =>
  new Date(NOW.getTime() - n * 60 * 1000).toISOString();

const reported = (
  entries: Partial<Record<StageId, ReportedStage>>,
): Partial<Record<StageId, ReportedStage>> => entries;

describe('resolveStages', () => {
  it('leaves a reported stage exactly as reported', () => {
    const result = resolveStages(
      reported({
        access: { status: 'success', updatedAt: minutesAgo(30) },
        quality: { status: 'failure', updatedAt: minutesAgo(29) },
      }),
      NOW,
    );

    expect(result.access.status).toBe('success');
    expect(result.quality.status).toBe('failure');
  });

  it('calls a stage blocked when an earlier one failed', () => {
    // The chain stops, so package will never run. Reporting it as pending
    // implies it still might.
    const result = resolveStages(
      reported({
        access: { status: 'success', updatedAt: minutesAgo(30) },
        quality: { status: 'failure', updatedAt: minutesAgo(29) },
      }),
      NOW,
    );

    expect(result.package.status).toBe('blocked');
    expect(result.package.friendlyMessages[0]?.detail).toContain('quality');
  });

  it('calls a stage stalled when the one before it succeeded and nothing came', () => {
    // This is the case that was invisible: a workflow rejected at startup runs
    // no jobs, so it cannot report, and the pipeline sat on "pending" forever.
    const result = resolveStages(
      reported({
        access: { status: 'success', updatedAt: minutesAgo(60) },
      }),
      NOW,
    );

    expect(result.quality.status).toBe('stalled');
    expect(result.quality.friendlyMessages[0]?.severity).toBe('error');
    expect(result.quality.friendlyMessages[0]?.hint).toContain('GitHub');
  });

  it('still says pending inside the grace window', () => {
    // A queued run on a busy runner is legitimately pending. Calling that
    // broken would replace one wrong answer with another.
    const result = resolveStages(
      reported({
        access: {
          status: 'success',
          updatedAt: new Date(
            NOW.getTime() - STALLED_AFTER_MS + 60_000,
          ).toISOString(),
        },
      }),
      NOW,
    );

    expect(result.quality.status).toBe('pending');
    expect(result.quality.friendlyMessages).toEqual([]);
  });

  it('says pending when nothing has succeeded yet', () => {
    const result = resolveStages(
      reported({ access: { status: 'running', updatedAt: minutesAgo(60) } }),
      NOW,
    );

    expect(result.quality.status).toBe('pending');
    expect(result.package.status).toBe('pending');
  });

  it('treats a run with no reports at all as pending, not broken', () => {
    const result = resolveStages(reported({}), NOW);

    expect(Object.values(result).every((s) => s.status === 'pending')).toBe(
      true,
    );
  });

  it('does not blame a stage for a failure that came after it', () => {
    const result = resolveStages(
      reported({
        access: { status: 'success', updatedAt: minutesAgo(60) },
        quality: { status: 'success', updatedAt: minutesAgo(59) },
        package: { status: 'failure', updatedAt: minutesAgo(58) },
      }),
      NOW,
    );

    expect(result.access.status).toBe('success');
    expect(result.quality.status).toBe('success');
  });

  it('blames one stage, not every stage after it', () => {
    // access succeeded long ago and nothing followed. Quality is the problem;
    // package is a consequence. Marking both stalled would report one broken
    // pipeline as two.
    const result = resolveStages(
      reported({ access: { status: 'success', updatedAt: minutesAgo(60) } }),
      NOW,
    );

    expect(result.quality.status).toBe('stalled');
    expect(result.package.status).toBe('blocked');
    expect(result.package.friendlyMessages[0]?.detail).toContain('quality');
  });

  it('survives an unparseable timestamp without inventing a failure', () => {
    const result = resolveStages(
      reported({ access: { status: 'success', updatedAt: 'not-a-date' } }),
      NOW,
    );

    expect(result.quality.status).toBe('pending');
  });
});

describe('resolveOverallStatus', () => {
  it('counts a stalled stage as a failed run', () => {
    // The pipeline stopped and will not continue on its own.
    const status = resolveOverallStatus([
      { status: 'success', friendlyMessages: [] },
      { status: 'stalled', friendlyMessages: [] },
      { status: 'pending', friendlyMessages: [] },
    ]);

    expect(status).toBe('failure');
  });

  it('does not count a blocked stage as a second failure', () => {
    const status = resolveOverallStatus([
      { status: 'success', friendlyMessages: [] },
      { status: 'failure', friendlyMessages: [] },
      { status: 'blocked', friendlyMessages: [] },
    ]);

    expect(status).toBe('failure');
  });

  it('is success only when every stage succeeded', () => {
    expect(
      resolveOverallStatus([
        { status: 'success', friendlyMessages: [] },
        { status: 'success', friendlyMessages: [] },
        { status: 'success', friendlyMessages: [] },
      ]),
    ).toBe('success');
  });

  it('is partial while stages are still pending', () => {
    expect(
      resolveOverallStatus([
        { status: 'success', friendlyMessages: [] },
        { status: 'pending', friendlyMessages: [] },
        { status: 'pending', friendlyMessages: [] },
      ]),
    ).toBe('partial');
  });
});
