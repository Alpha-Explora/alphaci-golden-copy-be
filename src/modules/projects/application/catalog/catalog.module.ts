import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { GithubModule } from '#modules/pipelines/github/github.module';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { CatalogController } from '../../api/catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [SubscriptionModule, GithubModule],
  controllers: [CatalogController],
  providers: [CatalogService, SessionAuthGuard, SubscriptionGuard],
  exports: [CatalogService],
})
export class CatalogModule {}
