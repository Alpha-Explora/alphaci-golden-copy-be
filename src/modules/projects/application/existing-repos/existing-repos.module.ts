import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { CatalogModule } from '../catalog/catalog.module';
import { GithubModule } from '#modules/pipelines/github/github.module';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { ExistingReposController } from '../../api/existing-repos.controller';
import { ExistingReposService } from './existing-repos.service';

@Module({
  imports: [CatalogModule, GithubModule, SubscriptionModule],
  controllers: [ExistingReposController],
  providers: [ExistingReposService, SessionAuthGuard, SubscriptionGuard],
})
export class ExistingReposModule {}
