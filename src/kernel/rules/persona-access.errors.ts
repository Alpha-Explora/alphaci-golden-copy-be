import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

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

export function projectFeaturesRequired(
  deliveryProjectId: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'PROJECT_FEATURES_REQUIRED',
    message:
      'Your Product owner adds a Feature to this Project before repositories can be created in it.',
    deliveryProjectId,
  });
}
