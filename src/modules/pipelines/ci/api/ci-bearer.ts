import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { CiService } from '../application/ci.service';

/** The ALPHACI_TOKEN from an `Authorization: Bearer ...` header, or a 401. */
export function extractBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    throw new UnauthorizedException('Bearer CI token is required');
  }
  return match[1].trim();
}

/**
 * Runs BEFORE a multipart interceptor, so an anonymous or revoked-token caller
 * is refused before the server buffers up to a file's worth of memory for it.
 * It proves only that the bearer is an active project token; the controller
 * still binds the token to the repository named in the form fields (which are
 * not readable until the body has been parsed) with CiService.validateRun.
 */
@Injectable()
export class CiActiveTokenGuard implements CanActivate {
  constructor(private readonly ciService: CiService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    await this.ciService.assertActiveToken(
      extractBearerToken(request.headers.authorization),
    );
    return true;
  }
}
