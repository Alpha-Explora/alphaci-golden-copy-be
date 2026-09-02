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
 * PlatformAdminGuard — gates the Admin Console on the GLOBAL admin tier.
 *
 * Access is granted to a user whose global `app_role` is 'admin', OR the
 * permanent platform super-admin (identity.platform_admins.role='super_admin').
 * This deliberately does NOT grant access on a bare platform_admins 'admin'
 * row: a user who has been set to Lead or Member in the Admin Console must lose
 * admin-tab access (product decision 2026-07-14 — "members and leads should not
 * access the admin tab"). The super-admin is always allowed so the permanent
 * admin can never be locked out.
 *
 * Designed to run AFTER SessionAuthGuard (which populates req.session.user), e.g.
 *   @UseGuards(SessionAuthGuard, PlatformAdminGuard)
 * Apply it at the CONTROLLER level so every admin route is locked by default and a
 * new endpoint cannot accidentally ship unguarded.
 *
 * Returns 403 (the user is authenticated but lacks the role).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly platformAdminAccessService: PlatformAdminAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.session?.user?.id ?? request.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    // The permanent super-admin always has access.
    const platformRole = await this.platformAdminAccessService.findRole(userId);
    if (platformRole === 'super_admin') {
      return true;
    }

    const appRole = await this.platformAdminAccessService.findAppRole(userId);
    if (appRole === 'admin') {
      return true;
    }

    throw new ForbiddenException('Admin access required');
  }
}
