import { WorkflowFragmentRegistry } from '../../../core/workflow-fragment.contract';
import type { WorkflowFragment } from '../../../core/workflow-fragment.contract';

describe('WorkflowFragmentRegistry', () => {
  it('accepts a provider plugin without a provider-specific switch', () => {
    const fragment: WorkflowFragment = {
      provider: 'fake-cloud',
      build: jest.fn().mockReturnValue({
        jobs: { 'deploy-fake-cloud': { runs_on: 'ubuntu-latest' } },
        jobIds: ['deploy-fake-cloud'],
        promotionNeeds: [],
      }),
    };
    const registry = new WorkflowFragmentRegistry([fragment]);

    expect(
      registry.get('fake-cloud')?.build(
        {
          provider: 'fake-cloud',
          slot: 'backend',
          deploymentStrategy: 'fake_native',
        },
        'uat',
        {
          serviceName: 'orders-api',
          servicePath: '.',
          centralWorkflowRef: 'v1',
        },
      ),
    ).toEqual({
      jobs: { 'deploy-fake-cloud': { runs_on: 'ubuntu-latest' } },
      jobIds: ['deploy-fake-cloud'],
      promotionNeeds: [],
    });
  });

  it('rejects duplicate provider fragments', () => {
    const fragment: WorkflowFragment = {
      provider: 'fake-cloud',
      build: jest.fn(),
    };

    expect(
      () => new WorkflowFragmentRegistry([fragment, fragment]),
    ).toThrow('Duplicate workflow fragment provider: fake-cloud');
  });
});
