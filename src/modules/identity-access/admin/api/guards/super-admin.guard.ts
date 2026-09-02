import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { PlatformAdminAccessService } from '../../application/platform-admin-access.service';

/**
 * SuperAdminGuard — allows only platform super-admins.
 *
 * Apply this IN ADDITION to the controller-level PlatformAdminGuard on the small
 * set of privileged endpoints that grant/revoke admin — the single most dangerous
 * operation in the feature. Keeping it as a separate, narrowly-applied guard makes
 * the privilege boundary obvious at the call site:
 *   @UseGuards(SuperAdminGuard)
 *   @Post('users/:id/role') ...
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(
    private readonly platformAdminAccessService: PlatformAdminAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.session?.user?.id ?? request.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const role = await this.platformAdminAccessService.findRole(userId);
    if (role !== 'super_admin') {
      throw new ForbiddenException('Super-admin access required');
    }

    return true;
  }
}
