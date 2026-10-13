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

  /*
   * The message must not pick a cause.
   *
   * It used to state that the workflow "was rejected before any job ran", and
   * the first real stalled stage checked against it had run nine jobs and
   * reported in full - the report was filed under another branch, because
   * workflow_run reads the workflow file from the default branch. A reader
   * following that text hunted a startup rejection that never happened.
   */
  it('does not announce a cause it cannot have established', () => {
    const result = resolveStages(
      reported({ access: { status: 'success', updatedAt: minutesAgo(60) } }),
      NOW,
    );

    const message = result.quality.friendlyMessages[0];

    expect(message?.detail).not.toContain('That means');
    expect(`${message?.detail ?? ''} ${message?.hint ?? ''}`).not.toMatch(
      /was rejected before any job ran/,
    );
  });

  it('names both a stage that never ran and one that reported elsewhere', () => {
    const result = resolveStages(
      reported({ access: { status: 'success', updatedAt: minutesAgo(60) } }),
      NOW,
    );

    const message = result.quality.friendlyMessages[0];
    const text = `${message?.detail ?? ''} ${message?.hint ?? ''}`;

    expect(text).toMatch(/never ran/i);
    expect(text).toMatch(/another branch/i);
    // And it still tells the reader how to tell the two apart.
    expect(text).toMatch(/if jobs ran/i);
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

describe('resolveStages on a branch', () => {
  const allGreenButVerify = reported({
    access: { status: 'success', updatedAt: minutesAgo(60) },
    quality: { status: 'success', updatedAt: minutesAgo(59) },
    package: { status: 'success', updatedAt: minutesAgo(58) },
  });

  it('does not stall verify on dev, where nothing is hosted and verify never runs', () => {
    const result = resolveStages(allGreenButVerify, NOW, 'dev');

    expect(result.verify.status).toBe('not_applicable');
    expect(result.verify.friendlyMessages).toEqual([]);
    expect(resolveOverallStatus(Object.values(result))).toBe('success');
  });

  it('still stalls verify on uat, where it is expected to report', () => {
    const result = resolveStages(allGreenButVerify, NOW, 'uat');

    expect(result.verify.status).toBe('stalled');
    expect(resolveOverallStatus(Object.values(result))).toBe('failure');
  });

  it('still stalls verify on main', () => {
    expect(resolveStages(allGreenButVerify, NOW, 'main').verify.status).toBe(
      'stalled',
    );
  });

  it('keeps legacy behaviour when no branch is given', () => {
    expect(resolveStages(allGreenButVerify, NOW).verify.status).toBe('stalled');
  });

  it('treats the chained stages of a feature branch as not applicable', () => {
    const result = resolveStages(
      reported({ access: { status: 'success', updatedAt: minutesAgo(60) } }),
      NOW,
      'feature/login',
    );

    expect(result.quality.status).toBe('not_applicable');
    expect(result.package.status).toBe('not_applicable');
    expect(result.verify.status).toBe('not_applicable');
    expect(resolveOverallStatus(Object.values(result))).toBe('success');
  });

  it('reports a stage that did report, even where the rule says it should not', () => {
    const result = resolveStages(
      reported({
        access: { status: 'success', updatedAt: minutesAgo(60) },
        quality: { status: 'failure', updatedAt: minutesAgo(59) },
      }),
      NOW,
      'feature/login',
    );

    expect(result.quality.status).toBe('failure');
  });

  it('prefers not_applicable over blocked when an earlier stage failed', () => {
    const result = resolveStages(
      reported({
        access: { status: 'success', updatedAt: minutesAgo(60) },
        quality: { status: 'failure', updatedAt: minutesAgo(59) },
      }),
      NOW,
      'dev',
    );

    expect(result.package.status).toBe('blocked');
    expect(result.verify.status).toBe('not_applicable');
  });
});

describe('resolveOverallStatus', () => {
  it('ignores a stage that does not apply to the branch', () => {
    expect(
      resolveOverallStatus([
        { status: 'success', friendlyMessages: [] },
        { status: 'success', friendlyMessages: [] },
        { status: 'not_applicable', friendlyMessages: [] },
      ]),
    ).toBe('success');
  });

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
