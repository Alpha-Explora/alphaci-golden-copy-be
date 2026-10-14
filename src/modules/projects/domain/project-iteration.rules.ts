import type { ProjectIterationStatus } from '../application/qa-checklists/project-iterations.contracts';

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
