import {
  mapVercelDeployEvent,
  mapVercelDeployHistory,
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
