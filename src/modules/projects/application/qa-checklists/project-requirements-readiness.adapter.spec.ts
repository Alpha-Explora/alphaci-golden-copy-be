import type { CapabilityResolverPort } from '#kernel/composition/capability-resolver.port.js';
import type { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import { ProjectRequirementsReadinessAdapter } from './project-requirements-readiness.adapter';

function build(capabilityOn: boolean) {
  const checklists = {
    countActiveFeaturesByDeliveryProject: jest
      .fn()
      .mockResolvedValue(new Map([['dp-1', 2]])),
  };
  const has = jest.fn().mockReturnValue(capabilityOn);
  const resolver = {
    deployment: () => ({ has }),
  } as unknown as CapabilityResolverPort;
  const adapter = new ProjectRequirementsReadinessAdapter(
    checklists as unknown as QaChecklistsRepository,
    resolver,
  );
  return { adapter, checklists, has };
}

describe('ProjectRequirementsReadinessAdapter', () => {
  it('reads the deployment capability for the rule switch', () => {
    const { adapter, has } = build(true);
    expect(adapter.isFeatureRuleEnabled()).toBe(true);
    expect(has).toHaveBeenCalledWith('projects.qa-checklists');
    expect(build(false).adapter.isFeatureRuleEnabled()).toBe(false);
  });

  it('returns every requested id, 0 for Projects without an active Feature', async () => {
    const { adapter, checklists } = build(true);
    const counts = await adapter.countActiveFeatures(['dp-1', 'dp-2']);
    expect(counts).toEqual(
      new Map([
        ['dp-1', 2],
        ['dp-2', 0],
      ]),
    );
    expect(
      checklists.countActiveFeaturesByDeliveryProject,
    ).toHaveBeenCalledTimes(1);
  });

  it('returns zeros without querying when the capability is off', async () => {
    const { adapter, checklists } = build(false);
    const counts = await adapter.countActiveFeatures(['dp-1']);
    expect(counts).toEqual(new Map([['dp-1', 0]]));
    expect(
      checklists.countActiveFeaturesByDeliveryProject,
    ).not.toHaveBeenCalled();
  });

  it('does not query for an empty id list', async () => {
    const { adapter, checklists } = build(true);
    expect((await adapter.countActiveFeatures([])).size).toBe(0);
    expect(
      checklists.countActiveFeaturesByDeliveryProject,
    ).not.toHaveBeenCalled();
  });
});
