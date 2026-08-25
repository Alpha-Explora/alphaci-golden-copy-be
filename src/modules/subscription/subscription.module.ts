import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { DatabaseModule } from '../../kernel/db/database.module';
import { EventsModule } from '../../kernel/events/events.module';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { SubscriptionsRepository } from './infra/subscriptions.repository';
import { SUBSCRIPTION_BOOTSTRAP } from './subscription.contracts';

@Module({
  imports: [DatabaseModule, EventsModule],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionsRepository,
    {
      provide: SUBSCRIPTION_BOOTSTRAP,
      useExisting: SubscriptionsRepository,
    },
    SubscriptionService,
    SessionAuthGuard,
  ],
  exports: [SubscriptionService, SUBSCRIPTION_BOOTSTRAP],
})
export class SubscriptionModule {}
