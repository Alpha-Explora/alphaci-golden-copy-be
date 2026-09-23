import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import type { DirectoryCaller } from '../domain/directory.types';

/**
 * The directory caller for an authenticated request. Every endpoint that
 * reads the directory builds its caller here, so the session's GitHub token
 * reaches the source the same way on each of them.
 */
export function directoryCallerFrom(req: Request): DirectoryCaller {
  const userId = req.session.user?.id ?? req.session.userId;
  if (!userId) {
    throw new UnauthorizedException('Authentication required');
  }
  return { userId, githubToken: req.session.githubAccessToken ?? null };
}
