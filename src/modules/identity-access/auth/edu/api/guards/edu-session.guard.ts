import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  EDU_AUTH_REPOSITORY,
  type EduAuthRepositoryPort,
} from '../../application/edu-auth.ports.js';

@Injectable()
export class EduSessionGuard implements CanActivate {
  constructor(
    @Inject(EDU_AUTH_REPOSITORY)
    private readonly repository: EduAuthRepositoryPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.session?.eduUserId;
    if (!userId) throw new UnauthorizedException('Authentication required');

    const account = await this.repository.findByUserId(userId);
    if (!account || account.status !== 'ACTIVE') {
      throw new UnauthorizedException('Authentication required');
    }
    request.session.eduRole = account.role;
    request.session.userId = account.userId;
    return true;
  }
}
