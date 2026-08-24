import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { CatalogModule } from '../catalog/catalog.module';
import { GithubModule } from '../github/github.module';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { ExistingReposController } from './existing-repos.controller';
import { ExistingReposService } from './existing-repos.service';

@Module({
  imports: [CatalogModule, GithubModule, SubscriptionModule],
  controllers: [ExistingReposController],
  providers: [ExistingReposService, SessionAuthGuard, SubscriptionGuard],
})
export class ExistingReposModule {}
