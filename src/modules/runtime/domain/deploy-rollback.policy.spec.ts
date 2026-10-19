import {
  currentLiveDeployId,
  readRollbackState,
  rollbackCandidate,
  rollbackReasonProblem,
} from './deploy-rollback.policy';

const event = (
  id: string,
  status: string,
  environment: string | null = null,
) => ({
  id,
  status,
  environment,
  commitSha: `${id}-sha`,
  commitMessage: `${id} message`,
});

describe('deploy rollback policy', () => {
  const render = [
    event('dep-3', 'live'),
    event('dep-2', 'deactivated'),
    event('dep-1', 'build_failed'),
  ];
  const vercel = [
    event('dpl-4', 'READY', 'preview'),
    event('dpl-3', 'READY', 'production'),
    event('dpl-2', 'READY', 'production'),
    event('dpl-1', 'ERROR', 'production'),
  ];

  it('finds the deploy serving traffic: Render live, Vercel newest ready production, or the held rollback', () => {
    expect(currentLiveDeployId('render', render, null)).toBe('dep-3');
    expect(currentLiveDeployId('vercel', vercel, null)).toBe('dpl-3');
    expect(currentLiveDeployId('vercel', vercel, { deployId: 'dpl-2' })).toBe(
      'dpl-2',
    );
  });

  it('accepts an earlier deploy that went live', () => {
    expect(
      rollbackCandidate({
        provider: 'render',
        deployId: 'dep-2',
        events: render,
        rollback: null,
      }),
    ).toMatchObject({
      ok: true,
      event: { id: 'dep-2', commitSha: 'dep-2-sha' },
    });
    expect(
      rollbackCandidate({
        provider: 'vercel',
        deployId: 'dpl-2',
        events: vercel,
        rollback: null,
      }).ok,
    ).toBe(true);
  });

  it.each([
    [
      'render',
      'dep-9',
      null,
      "That deploy is not among this service's recent deploys.",
    ],
    ['render', 'dep-1', null, 'Only a deploy that went live can be put back.'],
    ['render', 'dep-3', null, 'That deploy is already live.'],
    [
      'vercel',
      'dpl-4',
      null,
      'Only a production deployment can be put back live on Vercel.',
    ],
    ['vercel', 'dpl-3', null, 'That deploy is already live.'],
    ['vercel', 'dpl-2', { deployId: 'dpl-2' }, 'That deploy is already live.'],
  ] as const)('refuses %s %s', (provider, deployId, rollback, reason) => {
    const events = provider === 'render' ? render : vercel;
    expect(rollbackCandidate({ provider, deployId, events, rollback })).toEqual(
      { ok: false, reason },
    );
  });

  it('requires a reason of a sensible length', () => {
    expect(rollbackReasonProblem('checkout is broken')).toBeNull();
    expect(rollbackReasonProblem('  ')).toBe('Say why you are rolling back.');
    expect(rollbackReasonProblem(undefined)).toBe(
      'Say why you are rolling back.',
    );
    expect(rollbackReasonProblem('x'.repeat(501))).toBe(
      'Keep the reason under 500 characters.',
    );
  });

  it('reads a held rollback back from provider metadata, and nothing else', () => {
    expect(
      readRollbackState({
        rollback: {
          deployId: 'dpl-2',
          commitSha: 'abc',
          reason: 'r',
          holdsNewDeploys: true,
        },
      }),
    ).toMatchObject({
      deployId: 'dpl-2',
      commitSha: 'abc',
      holdsNewDeploys: true,
    });
    expect(readRollbackState({})).toBeNull();
    expect(readRollbackState({ rollback: 'x' })).toBeNull();
    expect(readRollbackState(null)).toBeNull();
  });
});
