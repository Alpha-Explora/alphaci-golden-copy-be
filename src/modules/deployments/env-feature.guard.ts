import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';

@Injectable()
export class EnvFeatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(): boolean {
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (!config.envProvisioning.enabled) {
      throw new NotFoundException('Environment provisioning is not enabled');
    }

    return true;
  }
}
