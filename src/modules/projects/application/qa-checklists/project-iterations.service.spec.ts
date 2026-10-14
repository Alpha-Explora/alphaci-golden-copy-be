import { NotFoundException } from '@nestjs/common';

import {
  deliveredIterationRow,
  fakeIterations,
  iterationRow,
} from '../../__fixtures__/project-iterations';

const DP = 'dp-1';

describe('ProjectIterationsService.ensureActiveIteration', () => {
  it('returns the active Iteration of the Project without writing', async () => {
    const { service, repository } = fakeIterations();

    const row = await service.ensureActiveIteration(DP);

    expect(row.id).toBe('it-1');
    expect(repository.findCurrent).toHaveBeenCalledWith(DP);
    expect(repository.insertFirstIfNone).not.toHaveBeenCalled();
  });

  it('creates Iteration 1 on first use, then reads it back', async () => {
    const { service, repository } = fakeIterations();
    repository.findCurrent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(iterationRow());

    const row = await service.ensureActiveIteration(DP);

    expect(repository.insertFirstIfNone).toHaveBeenCalledWith([DP]);
    expect(row.number).toBe(1);
  });

  it('is idempotent under a race: the loser of the insert still reads the winner', async () => {
    const { service, repository } = fakeIterations();
    repository.findCurrent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(iterationRow({ id: 'it-winner' }));
    // insertFirstIfNone is ON CONFLICT DO NOTHING: it resolves either way.

    await expect(service.ensureActiveIteration(DP)).resolves.toMatchObject({
      id: 'it-winner',
    });
  });

  it('between delivery and the next start it is the latest DELIVERED one', async () => {
    const delivered = deliveredIterationRow({ number: 3 });
    const { service } = fakeIterations(delivered);

    await expect(service.ensureActiveIteration(DP)).resolves.toMatchObject({
      number: 3,
      status: 'delivered',
    });
  });

  it('fails loudly if the Iteration still does not exist after creating it', async () => {
    const { service, repository } = fakeIterations();
    repository.findCurrent.mockResolvedValue(null);

    await expect(service.ensureActiveIteration(DP)).rejects.toThrow(
      'Could not create Iteration 1',
    );
  });
});

describe('ProjectIterationsService.ensureForProjects', () => {
  it('resolves many Projects in one read when none is missing', async () => {
    const { service, repository } = fakeIterations();

    const map = await service.ensureForProjects([DP]);

    expect(map.get(DP)?.id).toBe('it-1');
    expect(repository.findCurrentByDeliveryProjects).toHaveBeenCalledTimes(1);
    expect(repository.insertFirstIfNone).not.toHaveBeenCalled();
  });

  it('creates Iteration 1 for the missing Projects only, in one statement', async () => {
    const { service, repository } = fakeIterations();

    await service.ensureForProjects([DP, 'dp-new', 'dp-new-2']);

    expect(repository.insertFirstIfNone).toHaveBeenCalledTimes(1);
    expect(repository.insertFirstIfNone).toHaveBeenCalledWith([
      'dp-new',
      'dp-new-2',
    ]);
    expect(repository.findCurrentByDeliveryProjects).toHaveBeenCalledTimes(2);
  });

  it('findCurrentForProjects never creates anything', async () => {
    const { service, repository } = fakeIterations();

    await service.findCurrentForProjects([DP, 'dp-new']);

    expect(repository.insertFirstIfNone).not.toHaveBeenCalled();
  });
});

describe('the iteration guard', () => {
  it('assertWritable passes for an active Iteration', () => {
    const { service } = fakeIterations();

    expect(() => service.assertWritable(iterationRow())).not.toThrow();
  });

  it('assertWritable refuses a delivered one with 409 ITERATION_DELIVERED and the sentence', () => {
    const { service } = fakeIterations();

    expect.assertions(3);
    try {
      service.assertWritable(deliveredIterationRow({ number: 7 }));
    } catch (error) {
      expect(error).toMatchObject({ status: 409 });
      expect((error as { response: unknown }).response).toMatchObject({
        code: 'ITERATION_DELIVERED',
        iterationNumber: 7,
      });
      expect(
        (error as { response: { message: string } }).response.message,
      ).toBe(
        'Iteration 7 was delivered. Start the next iteration to change this.',
      );
    }
  });

  it('assertRowWritable guards by the Iteration of the ROW, not the current one of the Project', async () => {
    const { service, repository } = fakeIterations(
      iterationRow({ id: 'it-current', number: 3 }),
    );
    repository.findById.mockResolvedValue(
      deliveredIterationRow({ id: 'it-old', number: 2 }),
    );

    await expect(
      service.assertRowWritable({ iteration_id: 'it-old' }),
    ).rejects.toMatchObject({ response: { code: 'ITERATION_DELIVERED' } });
    expect(repository.findById).toHaveBeenCalledWith('it-old');
    expect(repository.findCurrent).not.toHaveBeenCalled();
  });

  it('assertRowWritable lets a row of an active Iteration through', async () => {
    const { service } = fakeIterations();

    await expect(
      service.assertRowWritable({ iteration_id: 'it-1' }),
    ).resolves.toBeUndefined();
  });

  it('a row with no Iteration (unassigned legacy checklist) is not guarded and costs no read', async () => {
    const { service, repository } = fakeIterations(deliveredIterationRow());

    await expect(
      service.assertRowWritable({ iteration_id: null }),
    ).resolves.toBeUndefined();
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('a row pointing at a missing Iteration is refused, not waved through', async () => {
    const { service, repository } = fakeIterations();
    repository.findById.mockResolvedValue(null);

    await expect(
      service.assertRowWritable({ iteration_id: 'gone' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProjectIterationsService API reads', () => {
  it('lists newest first through the Project visibility rule (404 for a non-member)', async () => {
    const { service, repository, projectContext } = fakeIterations();
    repository.list.mockResolvedValue([
      iterationRow({ id: 'it-2', number: 2 }),
      deliveredIterationRow({
        id: 'it-1',
        delivered_by: 'u-1',
        delivered_by_login: 'lead',
      }),
    ]);

    const list = await service.listForProject(DP, 'user-1');

    expect(projectContext.requireProject).toHaveBeenCalledWith(DP, 'user-1');
    expect(list.iterations.map((row) => [row.number, row.status])).toEqual([
      [2, 'active'],
      [1, 'delivered'],
    ]);
    expect(list.iterations[1]).toMatchObject({
      deliveredAt: '2026-10-10T00:00:00.000Z',
      deliveredBy: { id: 'u-1', login: 'lead' },
    });

    projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );
    await expect(service.listForProject(DP, 'stranger')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.currentForProject(DP, 'stranger')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('a Project nobody has opened yet still lists Iteration 1', async () => {
    const { service, repository } = fakeIterations();
    repository.findCurrent
      .mockResolvedValueOnce(null)
      .mockResolvedValue(iterationRow());

    await service.listForProject(DP, 'user-1');

    expect(repository.insertFirstIfNone).toHaveBeenCalledWith([DP]);
  });

  it('current: the active Iteration, canStartNext false while one is active', async () => {
    const { service } = fakeIterations(
      iterationRow({ goal: 'Loyalty points' }),
    );

    await expect(service.currentForProject(DP, 'lead-1')).resolves.toEqual({
      iteration: expect.objectContaining({
        id: 'it-1',
        number: 1,
        status: 'active',
        goal: 'Loyalty points',
        startedAt: '2026-10-01T00:00:00.000Z',
        deliveredAt: null,
      }),
      canStartNext: false,
      deliveredRepositories: [],
    });
  });

  it('current: with none active, the last delivered one, and canStartNext only for lead or admin', async () => {
    const delivered = deliveredIterationRow({ number: 4 });

    const lead = fakeIterations(delivered, { canManage: true });
    const leadView = await lead.service.currentForProject(DP, 'lead-1');
    expect(leadView.iteration).toMatchObject({
      number: 4,
      status: 'delivered',
    });
    expect(leadView.canStartNext).toBe(true);

    const other = fakeIterations(delivered, { canManage: false });
    expect(
      (await other.service.currentForProject(DP, 'qa-1')).canStartNext,
    ).toBe(false);
  });

  it('current: deliveredRepositories reads the stored delivery state in every status, and is empty when absent or malformed', async () => {
    const stored = [
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        uatHeadSha: 'a'.repeat(40),
        mergeSha: 'b'.repeat(40),
        prNumber: 7,
        how: 'merged',
        at: '2026-10-10T00:00:00.000Z',
      },
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        uatHeadSha: 'c'.repeat(40),
        how: 'already_in_main',
      },
    ];
    const expected = [
      expect.objectContaining({ repoFullName: 'acme/api', prNumber: 7 }),
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        uatHeadSha: 'c'.repeat(40),
        mergeSha: null,
        prNumber: null,
        how: 'already_in_main',
        at: '',
      },
    ];

    // The stored shape is { repositories: [...] }; the phase 1 bare list still reads.
    for (const json of [{ repositories: stored }, stored]) {
      const delivered = fakeIterations(
        deliveredIterationRow({ delivery_json: json }),
      );
      expect(
        (await delivered.service.currentForProject(DP, 'u'))
          .deliveredRepositories,
      ).toEqual(expected);
    }

    // While still active, the incremental state is visible too (P9).
    const active = fakeIterations(
      iterationRow({ delivery_json: { repositories: stored } }),
    );
    expect(
      (await active.service.currentForProject(DP, 'u')).deliveredRepositories,
    ).toEqual(expected);

    const malformed = fakeIterations(
      deliveredIterationRow({ delivery_json: { not: 'a list' } }),
    );
    expect(
      (await malformed.service.currentForProject(DP, 'u'))
        .deliveredRepositories,
    ).toEqual([]);
  });

  it('renders timestamps from pg as ISO strings whether they arrive as Date or string', async () => {
    const { service } = fakeIterations(
      iterationRow({
        started_at: new Date('2026-10-02T03:04:05.000Z') as unknown as string,
      }),
    );

    expect((await service.currentForProject(DP, 'u')).iteration.startedAt).toBe(
      '2026-10-02T03:04:05.000Z',
    );
  });
});
