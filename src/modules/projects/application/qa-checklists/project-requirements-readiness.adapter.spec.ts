import type { CapabilityResolverPort } from '#kernel/composition/capability-resolver.port.js';
import { fakeIterations } from '../../__fixtures__/project-iterations';
import type { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import { ProjectRequirementsReadinessAdapter } from './project-requirements-readiness.adapter';

function build(capabilityOn: boolean) {
  const { service: iterations, repository: iterationRepository } =
    fakeIterations();
  const checklists = {
    countActiveFeaturesByIteration: jest
      .fn()
      .mockResolvedValue(new Map([['dp-1', 2]])),
  };
  const has = jest.fn().mockReturnValue(capabilityOn);
  const resolver = {
    deployment: () => ({ has }),
  } as unknown as CapabilityResolverPort;
  const adapter = new ProjectRequirementsReadinessAdapter(
    checklists as unknown as QaChecklistsRepository,
    iterations,
    resolver,
  );
  return { adapter, checklists, has, iterationRepository };
}

describe('ProjectRequirementsReadinessAdapter', () => {
  it('reads the deployment capability for the rule switch', () => {
    const { adapter, has } = build(true);
    expect(adapter.isFeatureRuleEnabled()).toBe(true);
    expect(has).toHaveBeenCalledWith('projects.qa-checklists');
    expect(build(false).adapter.isFeatureRuleEnabled()).toBe(false);
  });

  it('returns every requested id, 0 for Projects without an active Feature', async () => {
    const { adapter, checklists, iterationRepository } = build(true);
    const counts = await adapter.countActiveFeatures(['dp-1', 'dp-2']);
    expect(counts).toEqual(
      new Map([
        ['dp-1', 2],
        ['dp-2', 0],
      ]),
    );
    expect(checklists.countActiveFeaturesByIteration).toHaveBeenCalledTimes(1);
    // Counted in each Project's CURRENT Iteration, read-only (nothing created).
    expect(checklists.countActiveFeaturesByIteration).toHaveBeenCalledWith([
      'it-1',
    ]);
    expect(iterationRepository.insertFirstIfNone).not.toHaveBeenCalled();
  });

  it('returns zeros without querying when the capability is off', async () => {
    const { adapter, checklists } = build(false);
    const counts = await adapter.countActiveFeatures(['dp-1']);
    expect(counts).toEqual(new Map([['dp-1', 0]]));
    expect(checklists.countActiveFeaturesByIteration).not.toHaveBeenCalled();
  });

  it('does not query for an empty id list', async () => {
    const { adapter, checklists } = build(true);
    expect((await adapter.countActiveFeatures([])).size).toBe(0);
    expect(checklists.countActiveFeaturesByIteration).not.toHaveBeenCalled();
  });
});
