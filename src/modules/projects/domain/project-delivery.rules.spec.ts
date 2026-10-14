import {
  coveredRepositoriesOf,
  deliveryEntryFor,
  describeCovered,
  isDeliveryComplete,
  mainContainsHead,
  parseDeliveryEntries,
} from './project-delivery.rules';

const SHA = 'a'.repeat(40);
const entry = (
  projectId: string,
  sha = SHA,
  how: 'merged' | 'already_in_main' = 'merged',
) => ({
  projectId,
  repoFullName: `acme/${projectId}`,
  uatHeadSha: sha,
  mergeSha: null,
  prNumber: null,
  how,
  at: '2026-10-14T00:00:00.000Z',
});
const repo = (projectId: string, headSha = SHA) => ({
  projectId,
  repoFullName: `acme/${projectId}`,
  headSha,
});

describe('mainContainsHead (compare/{uatHead}...main)', () => {
  it.each([
    ['ahead', true],
    ['identical', true],
    ['behind', false],
    ['diverged', false],
    [null, false],
  ] as const)('%s -> %s', (status, expected) => {
    expect(mainContainsHead(status)).toBe(expected);
  });
});

describe('coveredRepositoriesOf', () => {
  it('keeps only repositories still in the Project, ordered by name', () => {
    expect(
      coveredRepositoriesOf(
        [repo('web'), repo('gone'), repo('api')],
        new Set(['api', 'web']),
      ).map((r) => r.projectId),
    ).toEqual(['api', 'web']);
  });
});

describe('parseDeliveryEntries', () => {
  it('reads { repositories: [...] }, the phase 1 bare list, and nothing else', () => {
    expect(parseDeliveryEntries({ repositories: [entry('api')] })).toEqual([
      entry('api'),
    ]);
    expect(parseDeliveryEntries([entry('api')])).toEqual([entry('api')]);
    expect(parseDeliveryEntries(null)).toEqual([]);
    expect(parseDeliveryEntries({ repositories: 'x' })).toEqual([]);
    expect(parseDeliveryEntries('junk')).toEqual([]);
  });
});

describe('deliveryEntryFor / isDeliveryComplete', () => {
  it('while active, an entry must match the run head; a delivered Iteration is frozen', () => {
    const old = entry('api', 'd'.repeat(40));
    expect(deliveryEntryFor([old], repo('api'), 'active')).toBeNull();
    expect(deliveryEntryFor([old], repo('api'), 'delivered')).toBe(old);
    expect(deliveryEntryFor([entry('api')], repo('api'), 'active')).toEqual(
      entry('api'),
    );
  });

  it('is complete only with at least one covered repository and every one stored', () => {
    const covered = [repo('api'), repo('web')];
    expect(isDeliveryComplete([], [], 'active')).toBe(false);
    expect(isDeliveryComplete(covered, [entry('api')], 'active')).toBe(false);
    expect(
      isDeliveryComplete(covered, [entry('api'), entry('web')], 'active'),
    ).toBe(true);
  });

  it('describeCovered reports delivered and how', () => {
    expect(
      describeCovered(
        [repo('api'), repo('web')],
        [entry('web', SHA, 'already_in_main')],
        'active',
      ),
    ).toEqual([
      {
        projectId: 'api',
        repoFullName: 'acme/api',
        delivered: false,
        how: null,
      },
      {
        projectId: 'web',
        repoFullName: 'acme/web',
        delivered: true,
        how: 'already_in_main',
      },
    ]);
  });
});
