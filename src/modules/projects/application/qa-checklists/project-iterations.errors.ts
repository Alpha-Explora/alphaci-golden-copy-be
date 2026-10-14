import { ConflictException, NotFoundException } from '@nestjs/common';

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
