import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * DevOnlyGuard — blocks endpoints in production.
 *
 * Apply to diagnostic / config-check endpoints that should never be reachable
 * on production deployments. Returns 404 (not 403) to avoid signalling that
 * the route exists at all.
 *
 * Usage:
 *   @UseGuards(DevOnlyGuard)
 *   @Get('some-debug-endpoint')
 *   debugEndpoint() { ... }
 */
@Injectable()
export class DevOnlyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(): boolean {
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    if (nodeEnv === 'production') {
      throw new NotFoundException();
    }
    return true;
  }
}
