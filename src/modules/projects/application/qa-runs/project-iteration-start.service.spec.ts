import { NotFoundException } from '@nestjs/common';

import {
  deliveredIterationRow,
  fakeIterations,
  iterationRow,
} from '../../__fixtures__/project-iterations';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import type { QaProjectContextService } from '../qa-checklists/qa-project-context.service';
import {
  ProjectIterationStartService,
  QA_ITERATION_STARTED_EVENT,
} from './project-iteration-start.service';

const DP = 'dp-1';
const actor = { userId: 'lead-1', userLogin: 'lead', oauthToken: null };

interface Fixture {
  delivered?: ProjectIterationRow;
  canManage?: boolean;
  withPublishers?: boolean;
}

function build(options: Fixture = {}) {
  const delivered =
    options.delivered ??
    deliveredIterationRow({ id: 'it-1', number: 1, signoff_run_id: 'run-1' });
  const {
    service: iterations,
    repository,
    access,
    projectContext,
    state,
  } = fakeIterations(delivered, { canManage: options.canManage ?? true });
  repository.startNext.mockImplementation((input) => {
    const row = iterationRow({
      id: 'it-2',
      number: delivered.number + 1,
      goal: input.goal,
      started_by: input.startedBy,
      started_by_login: input.startedByLogin,
    });
    state.row = row;
    return Promise.resolve(row);
  });
  Object.assign(projectContext, {
    anchorProjectId: jest.fn().mockResolvedValue('p-api'),
  });
  Object.assign(access, {
    listWorkspaceLeadAndDeveloperIds: jest
      .fn()
      .mockResolvedValue(['lead-1', 'dev-1']),
    listWorkspaceQaIds: jest.fn().mockResolvedValue(['qa-1']),
  });
  const audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
  const notifications = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ProjectIterationStartService(
    access,
    projectContext as unknown as QaProjectContextService,
    iterations,
    options.withPublishers === false ? undefined : (audit as never),
    options.withPublishers === false ? undefined : (notifications as never),
  );
  return {
    service,
    repository,
    access,
    projectContext,
    audit,
    notifications,
    state,
  };
}

describe('ProjectIterationStartService.start', () => {
  it('a non-member gets the 404 and nothing is written', async () => {
    const f = build();
    f.projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );

    await expect(f.service.start(DP, actor, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.repository.startNext).not.toHaveBeenCalled();
  });

  it('a member who is not a lead or admin gets 403', async () => {
    const f = build({ canManage: false });

    await expect(f.service.start(DP, actor, {})).rejects.toMatchObject({
      status: 403,
      response: { code: 'ITERATION_START_FORBIDDEN' },
    });
    expect(f.repository.startNext).not.toHaveBeenCalled();
  });

  it('409 ITERATION_ACTIVE while an Iteration is active, naming it', async () => {
    const f = build({ delivered: iterationRow({ number: 3 }) });

    await expect(f.service.start(DP, actor, {})).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'ITERATION_ACTIVE',
        iterationNumber: 3,
        message:
          'Iteration 3 is still active. Deliver it before starting the next one.',
      },
    });
    expect(f.repository.startNext).not.toHaveBeenCalled();
  });

  it('two starts racing: one creates Iteration 2, the loser gets 409 ITERATION_ACTIVE', async () => {
    const f = build();
    // Behave like the partial unique index: the first caller to reach the
    // write wins, the second is refused with unique_violation.
    let taken = false;
    f.repository.startNext.mockImplementation(async (input) => {
      await Promise.resolve();
      if (taken) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      taken = true;
      const row = iterationRow({ id: 'it-2', number: 2, goal: input.goal });
      f.state.row = row;
      return row;
    });

    const results = await Promise.allSettled([
      f.service.start(DP, actor, {}),
      f.service.start(DP, actor, {}),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      response: { code: 'ITERATION_ACTIVE', iterationNumber: 2 },
    });
    // Only the winner announces.
    expect(f.audit.recordProjectEvent).toHaveBeenCalledTimes(1);
  });

  it('400 ITERATION_CARRY_INVALID when items are named to carry over: nothing is carried any more', async () => {
    const f = build();

    await expect(
      f.service.start(DP, actor, {
        carryOver: { requirementItemIds: ['a', 'b', 'a'] },
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'ITERATION_CARRY_INVALID',
        invalidIds: ['a', 'b'],
        message:
          'Items are no longer carried over: a new iteration starts with an empty checklist.',
      },
    });
    expect(f.repository.startNext).not.toHaveBeenCalled();
  });

  it('starts N+1 empty, with the trimmed goal', async () => {
    const f = build();

    const result = await f.service.start(DP, actor, {
      goal: '  Loyalty points  ',
    });

    expect(f.repository.startNext).toHaveBeenCalledWith({
      deliveryProjectId: DP,
      startedBy: 'lead-1',
      startedByLogin: 'lead',
      goal: 'Loyalty points',
    });
    expect(result).toEqual({
      iteration: expect.objectContaining({
        id: 'it-2',
        number: 2,
        status: 'active',
        goal: 'Loyalty points',
        startedBy: { id: 'lead-1', login: 'lead' },
      }),
    });
  });

  it('still accepts an empty carry-over list from an older client', async () => {
    const f = build();

    await expect(
      f.service.start(DP, actor, { carryOver: { requirementItemIds: [] } }),
    ).resolves.toMatchObject({ iteration: { number: 2 } });
    expect(f.repository.startNext).toHaveBeenCalledWith(
      expect.objectContaining({ goal: null }),
    );
  });

  it('an empty goal becomes null and one over 120 characters is a 400', async () => {
    const f = build();

    await f.service.start(DP, actor, { goal: '   ' });
    expect(f.repository.startNext).toHaveBeenCalledWith(
      expect.objectContaining({ goal: null }),
    );

    f.state.row = deliveredIterationRow({ id: 'it-1', number: 1 });
    await expect(
      f.service.start(DP, actor, { goal: 'x'.repeat(121) }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'ITERATION_GOAL_INVALID' },
    });
    await expect(
      f.service.start(DP, actor, { goal: 'x'.repeat(120) }),
    ).resolves.toBeDefined();
  });

  it('records qa.iteration.started and notifies Developers and QA, not the actor', async () => {
    const f = build();

    await f.service.start(DP, actor, { goal: 'Loyalty points' });

    expect(f.audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: QA_ITERATION_STARTED_EVENT,
        actorUserId: 'lead-1',
        projectId: 'p-api',
        metadata: {
          deliveryProjectId: DP,
          iterationId: 'it-2',
          number: 2,
        },
      }),
    );
    const recipients = f.notifications.record.mock.calls
      .map(([n]) => (n as { userId: string }).userId)
      .sort();
    expect(recipients).toEqual(['dev-1', 'qa-1']);
    expect(f.notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: QA_ITERATION_STARTED_EVENT,
        title: 'Iteration 2 of Checkout started',
        body: 'Goal: Loyalty points. It starts with an empty checklist.',
      }),
    );
  });

  it('omits a missing goal from the notification', async () => {
    const f = build();

    await f.service.start(DP, actor, {});

    expect(f.notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'It starts with an empty checklist.' }),
    );
  });

  it('a failing audit or notification does not undo the start', async () => {
    const f = build();
    f.audit.recordProjectEvent.mockRejectedValue(new Error('outbox down'));

    await expect(f.service.start(DP, actor, {})).resolves.toMatchObject({
      iteration: { number: 2 },
    });
  });

  it('still starts when no publisher is wired', async () => {
    const f = build({ withPublishers: false });

    await expect(f.service.start(DP, actor, {})).resolves.toMatchObject({
      iteration: { number: 2 },
    });
  });

  it('does not write the delivered Iteration or its rows', async () => {
    const f = build();

    await f.service.start(DP, actor, {});

    expect(f.repository.markDelivered).not.toHaveBeenCalled();
    expect(f.repository.recordRepositoryDelivery).not.toHaveBeenCalled();
  });
});
