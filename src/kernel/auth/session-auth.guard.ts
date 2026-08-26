import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(SESSION_USER_LOOKUP)
    private readonly sessionUserLookup: SessionUserLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.session?.user && !request.session?.userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!request.session.user && request.session.userId) {
      const user = await this.sessionUserLookup.findSessionUser(
        request.session.userId,
      );

      if (!user) {
        throw new UnauthorizedException('Authentication required');
      }

      request.session.user = user;
      request.session.userId = user.id;
    }

    return true;
  }
}
