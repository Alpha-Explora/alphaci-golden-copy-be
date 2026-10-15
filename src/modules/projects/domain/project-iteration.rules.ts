import type {
  CarryOverLastStatus,
  ProjectIterationStatus,
} from '../application/qa-checklists/project-iterations.contracts';

/**
 * Only an active Iteration accepts writes. A delivered one is a frozen record
 * (ITERATIONS_PLAN.md P8): the code is already in main, so even reopening a
 * run is refused.
 */
export function isIterationWritable(status: ProjectIterationStatus): boolean {
  return status === 'active';
}

/**
 * Whether "Start iteration N+1" is on offer: the Project has no active
 * Iteration, and the caller is one of the people who may merge (lead, admin).
 */
export function canStartNextIteration(input: {
  mayManage: boolean;
  hasActiveIteration: boolean;
}): boolean {
  return input.mayManage && !input.hasActiveIteration;
}

/**
 * Items QA failed, blocked or sent back to development in the delivering run:
 * when carried over they go back to Progress `in_progress` so they are re-done
 * (ITERATIONS_PLAN.md P13). Every other item keeps its source Progress.
 */
export const CARRY_OVER_RESET_STATUSES: readonly CarryOverLastStatus[] = [
  'failed',
  'blocked',
  'returned_to_dev',
];

/**
 * Whether a delivered item is pre-selected for carry-over: it is unfinished,
 * i.e. Progress is not `done`, or QA never settled it (no row in the
 * delivering run, or a status other than passed).
 */
export function isUnfinishedForCarryOver(input: {
  progress: 'todo' | 'in_progress' | 'done';
  lastStatus: CarryOverLastStatus | null;
}): boolean {
  return input.progress !== 'done' || input.lastStatus !== 'passed';
}
