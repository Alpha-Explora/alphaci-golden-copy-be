import type { QaProgress } from '../application/qa-checklists/qa-requirements.contracts';
import type { QaRunItemStatus } from '../application/qa-runs/qa-runs.contracts';
import { bucketMyQaItem, type QaMyItemsBucket } from './qa-my-items.rules';

describe('bucketMyQaItem', () => {
  const cases: Array<
    [QaProgress, QaRunItemStatus | null, QaMyItemsBucket | null]
  > = [
    // A returned run item wins over Progress.
    ['done', 'returned_to_dev', 'returned'],
    ['in_progress', 'returned_to_dev', 'returned'],
    ['todo', 'returned_to_dev', 'returned'],
    // Progress todo / in_progress win over everything else.
    ['in_progress', null, 'inProgress'],
    ['in_progress', 'pending', 'inProgress'],
    ['in_progress', 'passed', 'inProgress'],
    ['todo', null, 'todo'],
    ['todo', 'pending', 'todo'],
    ['todo', 'failed', 'todo'],
    // Only a done item that QA has not decided is QA's queue.
    ['done', null, 'readyForQa'],
    ['done', 'pending', 'readyForQa'],
    ['done', 'passed', null],
    ['done', 'failed', null],
    ['done', 'blocked', null],
    // Not a Project-run status any more: it is not pending, so not queued.
    ['done', 'in_progress', null],
  ];

  it.each(cases)(
    'progress %s with run item %s is in bucket %s',
    (progress, runItemStatus, bucket) => {
      expect(bucketMyQaItem(progress, runItemStatus)).toBe(bucket);
    },
  );
});
