import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Coded errors for Project Iterations, same body shape as qa-errors.ts:
 * `{ statusCode, error, code, message, ...extra }`.
 */

/** A write against a delivered Iteration (every Project-scoped QA write). */
export const iterationDelivered = (iterationNumber: number) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'ITERATION_DELIVERED',
    message: `Iteration ${iterationNumber} was delivered. Start the next iteration to change this.`,
    iterationNumber,
  });

export const iterationNotFound = () =>
  new NotFoundException('Iteration not found');

/** Merge all repositories on a Project that has no linked repository (P11). */
export const projectHasNoRepositories = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'PROJECT_HAS_NO_REPOSITORIES',
    message: 'Add a repository to this Project first.',
  });

/** Start the next Iteration while one is still active (also a lost race). */
export const iterationActive = (iterationNumber: number) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'ITERATION_ACTIVE',
    message: `Iteration ${iterationNumber} is still active. Deliver it before starting the next one.`,
    iterationNumber,
  });

/** A carry-over id that is not an item of the latest delivered Iteration. */
export const iterationCarryInvalid = (invalidIds: string[]) =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'ITERATION_CARRY_INVALID',
    message:
      'Some items cannot be carried over. Only items of the last delivered iteration can be.',
    invalidIds,
  });

export const iterationGoalInvalid = () =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'ITERATION_GOAL_INVALID',
    message: 'The goal can be at most 120 characters.',
  });

export const iterationStartForbidden = () =>
  new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'ITERATION_START_FORBIDDEN',
    message: 'Product owners start the next iteration.',
  });
