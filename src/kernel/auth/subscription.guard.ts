import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import {
  SUBSCRIPTION_ACCESS,
  type SubscriptionAccessPort,
} from './subscription-access.port';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    @Inject(SUBSCRIPTION_ACCESS)
    private readonly subscriptionService: SubscriptionAccessPort,
  ) {}

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
