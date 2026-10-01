import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Error shapes for the repository / Project create rules in
 * persona-access.rules.ts. One place so every create path (wizard, existing
 * repo setup, hierarchy create, raw GitHub repo create) answers identically
 * and the frontend can switch on `code`.
 */
export function repositoryCreateForbidden(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'REPOSITORY_CREATE_FORBIDDEN',
    message: 'Developers create repositories inside a Project.',
  });
}

export function projectCreateForbidden(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: 'PROJECT_CREATE_FORBIDDEN',
    message: 'Product owners create Projects.',
  });
}

export function projectRequired(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'PROJECT_REQUIRED',
    message: 'Choose the Project this repository belongs to.',
  });
}
