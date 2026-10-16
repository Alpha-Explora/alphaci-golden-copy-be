import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { appConfig } from '#kernel/config/app.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnv } from '#kernel/config/env.validation.js';
import { CorrelationIdMiddleware } from '#kernel/http/middleware/correlation-id.middleware.js';
import { HealthModule } from './health/health.module.js';
import { SupabaseModule } from '#kernel/db/supabase/supabase.module.js';
import { CompositionModule } from '#kernel/composition/composition.module.js';

// Bounded-context composition roots. Feature modules are wired behind these
// six roots so adding or extracting a context does not require editing the
// application module's feature list.
import { IdentityAccessModule } from '#modules/identity-access/identity-access.module.js';
import { BillingModule } from '#modules/billing/billing.module.js';
import { PipelinesModule } from '#modules/pipelines/pipelines.module.js';
import { ProjectsModule } from '#modules/projects/projects.module.js';
import { RuntimeModule } from '#modules/runtime/runtime.module.js';
import { OnpremMachineThrottlerGuard } from '#modules/runtime/index.js';
import { PlatformOpsModule } from '#modules/platform-ops/platform-ops.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      // The E2E suite sets this so a developer's local credentials can never
      // reach a test run; every value then comes from the process environment.
      ignoreEnvFile: process.env['ALPHACI_IGNORE_ENV_FILE'] === 'true',
      cache: true,
      load: [appConfig],
      // validateEnv runs unconditionally in all environments so that
      // missing/malformed secrets cause a hard crash at startup rather than
      // silently degrading to insecure fallbacks during local development.
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    SupabaseModule,
    CompositionModule,
    HealthModule,

    // Bounded contexts
    IdentityAccessModule,
    BillingModule,
    PipelinesModule,
    ProjectsModule,
    RuntimeModule,
    PlatformOpsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: OnpremMachineThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
