import {
  CanActivate,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  EDU_AUTH_CONFIG,
  type EduAuthConfig,
} from '../../application/edu-auth.ports.js';

/**
 * Local fail-closed seam until the profile-specific capability resolver is
 * wired by the orchestrator. This guard keeps an accidentally imported EDU
 * module inert in SaaS/Enterprise processes.
 */
@Injectable()
export class EduAuthEnabledGuard implements CanActivate {
  constructor(
    @Inject(EDU_AUTH_CONFIG) private readonly config: EduAuthConfig,
  ) {}

  canActivate(): boolean {
    if (!this.config.enabled) {
      throw new NotFoundException('Requested capability is not available');
    }
    return true;
  }
}
