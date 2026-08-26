import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { appConfig } from '#kernel/config/app.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnv } from '#kernel/config/env.validation.js';
import { CorrelationIdMiddleware } from '#kernel/http/middleware/correlation-id.middleware.js';
import { HealthModule } from './health/health.module.js';
import { SupabaseModule } from '#kernel/db/supabase/supabase.module.js';

// Ported Modules
import { AuthModule } from '#modules/identity-access/auth/auth.module.js';
import { GithubModule } from '#modules/pipelines/github/github.module.js';
import { SubscriptionModule } from '#modules/billing/subscription/subscription.module.js';
import { ProjectProvisioningModule } from '#modules/projects/project-provisioning.module.js';
import { ProjectReferenceModule } from '#modules/projects/project-reference.module.js';
import { CiModule } from '#modules/pipelines/ci/ci.module.js';
import { CapabilitiesModule } from '#modules/identity-access/index.js';
import { RuntimeModule } from '#modules/runtime/runtime.module.js';
import { UsageModule } from '#modules/billing/usage/usage.module.js';
import { WorkspacesModule } from '#modules/identity-access/workspaces/workspaces.module.js';
import { PlatformOpsModule } from '#modules/platform-ops/platform-ops.module.js';
import { AdminModule } from '#modules/identity-access/admin/admin.module.js';
import { GithubRoleAccessModule } from '#modules/identity-access/admin/github-role-access.module.js';
import { HierarchyModule } from '#modules/identity-access/hierarchy/hierarchy.module.js';
import { RuntimeCoreModule } from '#modules/runtime/core/runtime-core.module.js';
import { GcpDeploymentModule } from '#modules/runtime/infrastructure/providers/gcp/gcp.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
      load: [appConfig],
      // validateEnv runs unconditionally in all environments so that
      // missing/malformed secrets cause a hard crash at startup rather than
      // silently degrading to insecure fallbacks during local development.
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    SupabaseModule,
    HealthModule,

    // Business modules
    AuthModule,
    GithubModule,
    SubscriptionModule,
    CiModule,
    ProjectProvisioningModule,
    ProjectReferenceModule,
    CapabilitiesModule,
    RuntimeCoreModule,
    GcpDeploymentModule,
    RuntimeModule,
    UsageModule,
    WorkspacesModule,
    PlatformOpsModule,
    AdminModule,
    GithubRoleAccessModule,
    HierarchyModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
