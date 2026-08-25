import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { SubscriptionService } from '../../modules/subscription/index.js';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.session?.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const subscription = await this.subscriptionService.getForUser(user);
    if (subscription.status !== 'active') {
      throw new HttpException(
        'Active subscription required',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
