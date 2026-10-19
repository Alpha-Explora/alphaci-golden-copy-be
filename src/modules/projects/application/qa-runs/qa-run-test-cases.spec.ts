import type { QaRunTestCaseRow } from '../../infrastructure/qa-test-cases.repository';
import { groupRunTestCases } from './qa-run-test-cases';

const copy = (overrides: Partial<QaRunTestCaseRow>): QaRunTestCaseRow => ({
  id: 'rtc',
  run_id: 'run-1',
  run_item_id: 'ri-1',
  source_test_case_id: 'tc',
  source_category_id: 'cat-1',
  category_name: 'Happy path',
  category_position: 0,
  position: 0,
  title: 'Case',
  expected_result: null,
  status: 'pending',
  notes: null,
  verified_by: null,
  verified_by_login: null,
  verified_at: null,
  row_version: 1,
  updated_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('groupRunTestCases', () => {
  it('groups by category in position order, cases in position order', () => {
    const groups = groupRunTestCases(
      [
        copy({
          id: 'b',
          source_category_id: 'cat-2',
          category_name: 'Session',
          category_position: 1,
        }),
        copy({ id: 'a2', position: 1 }),
        copy({
          id: 'a1',
          position: 0,
          verified_by: 'qa-1',
          verified_by_login: 'qa',
          status: 'passed',
        }),
      ],
      null,
    );

    expect(
      groups.map((group) => [group.name, group.testCases.map((c) => c.id)]),
    ).toEqual([
      ['Happy path', ['a1', 'a2']],
      ['Session', ['b']],
    ]);
    expect(groups[0]?.testCases[0]?.verifiedBy).toEqual({
      id: 'qa-1',
      login: 'qa',
    });
  });

  it('keeps a deleted category of a frozen run under its name', () => {
    const groups = groupRunTestCases(
      [copy({ source_category_id: null })],
      null,
    );

    expect(groups).toEqual([
      expect.objectContaining({ id: null, name: 'Happy path' }),
    ]);
  });

  it('adds the live categories that hold no test case yet (open runs)', () => {
    const groups = groupRunTestCases(
      [copy({})],
      [
        {
          id: 'cat-1',
          position: 0,
          name: 'Happy path',
          rowVersion: 3,
          testCases: [
            {
              id: 'tc',
              position: 0,
              title: 'Case',
              expectedResult: null,
              rowVersion: 4,
            },
          ],
        },
        {
          id: 'cat-0',
          position: 2,
          name: 'Errors',
          rowVersion: 1,
          testCases: [],
        },
      ],
    );

    expect(groups.map((group) => [group.id, group.testCases.length])).toEqual([
      ['cat-1', 1],
      ['cat-0', 0],
    ]);
    // The definition row versions, so QA can edit from the run.
    expect(groups[0]?.rowVersion).toBe(3);
    expect(groups[0]?.testCases[0]?.definitionRowVersion).toBe(4);
  });

  it('gives a signed-off run no definition row versions', () => {
    const [group] = groupRunTestCases([copy({})], null);

    expect(group?.rowVersion).toBeNull();
    expect(group?.testCases[0]?.definitionRowVersion).toBeNull();
  });
});
