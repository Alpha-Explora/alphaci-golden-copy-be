import type { TestCaseCategory } from '../qa-checklists/qa-requirements.contracts';
import type { QaRunTestCaseRow } from '../../infrastructure/qa-test-cases.repository';
import type {
  ProjectQaRunTestCase,
  ProjectQaRunTestCategory,
} from './qa-runs.contracts';

export function toRunTestCase(
  row: QaRunTestCaseRow,
  definitionRowVersion: number | null = null,
): ProjectQaRunTestCase {
  return {
    id: row.id,
    sourceTestCaseId: row.source_test_case_id,
    position: row.position,
    title: row.title,
    expectedResult: row.expected_result,
    status: row.status,
    notes: row.notes,
    verifiedBy: row.verified_by
      ? { id: row.verified_by, login: row.verified_by_login ?? '' }
      : null,
    verifiedAt: row.verified_at,
    rowVersion: row.row_version,
    definitionRowVersion,
  };
}

/**
 * One story's test cases in a run, grouped by category in position order.
 * `copies` are the run's own rows (what QA recorded). `live` is the story's
 * categories right now, passed only for an OPEN run: a category QA just
 * created holds no test case yet, so it has no copy, and would otherwise not
 * show where QA adds its first test case. The live definitions also give each
 * category and test case its definition row_version, so QA can edit them
 * from an open run. A signed-off run shows exactly its copies.
 */
export function groupRunTestCases(
  copies: readonly QaRunTestCaseRow[],
  live: readonly TestCaseCategory[] | null,
): ProjectQaRunTestCategory[] {
  const liveCategories = new Map(
    (live ?? []).map((category) => [category.id, category]),
  );
  const liveCaseVersions = new Map(
    (live ?? []).flatMap((category) =>
      category.testCases.map(
        (testCase) => [testCase.id, testCase.rowVersion] as const,
      ),
    ),
  );
  const groups = new Map<
    string,
    { position: number; category: ProjectQaRunTestCategory }
  >();
  for (const copy of copies) {
    const key = copy.source_category_id ?? `name:${copy.category_name}`;
    const group = groups.get(key) ?? {
      position: copy.category_position,
      category: {
        id: copy.source_category_id,
        name: copy.category_name,
        rowVersion: copy.source_category_id
          ? (liveCategories.get(copy.source_category_id)?.rowVersion ?? null)
          : null,
        testCases: [],
      },
    };
    group.category.testCases.push(
      toRunTestCase(
        copy,
        copy.source_test_case_id
          ? (liveCaseVersions.get(copy.source_test_case_id) ?? null)
          : null,
      ),
    );
    groups.set(key, group);
  }
  for (const category of live ?? []) {
    if (!groups.has(category.id)) {
      groups.set(category.id, {
        position: category.position,
        category: {
          id: category.id,
          name: category.name,
          rowVersion: category.rowVersion,
          testCases: [],
        },
      });
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.category.name.localeCompare(b.category.name),
    )
    .map(({ category }) => ({
      ...category,
      testCases: [...category.testCases].sort(
        (a, b) => a.position - b.position,
      ),
    }));
}
