import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { Pool } from 'pg';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from '#kernel/http/filters/all-exceptions.filter.js';
import {
  BODY_SIZE_LIMIT,
  corsOptions,
  helmetConfig,
  helmetConfigSwagger,
} from '#kernel/config/security.config.js';
import type { AppConfig } from '#kernel/config/app.config.js';
import { postgresSslConfig } from '#kernel/db/postgres-ssl.config.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Required for Render (and any reverse-proxy deployment).
  // Render terminates TLS at the edge and sets X-Forwarded-Proto.
  // Without this, Express ignores the header, treats every request as plain
  // HTTP, and the secure:true + sameSite:none cookie combination silently
  // breaks all sessions in production.
  // Value 1 = trust exactly one hop — prevents X-Forwarded-For spoofing.
  app.set('trust proxy', 1);

  const configService = app.get(ConfigService);
  const appCfg = configService.getOrThrow<AppConfig>('app');

  const enableSwagger = configService.get<string>('ENABLE_SWAGGER') === 'true';

  // Session middleware
  let sessionStore: session.Store | undefined;
  if (appCfg.session.storeDriver === 'postgres' && appCfg.supabase.dbUrl) {
    // Lazy-require connect-pg-simple only when the postgres store is selected.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const connectPg = require('connect-pg-simple') as (
      s: typeof session,
    ) => new (options: Record<string, unknown>) => session.Store;
    const PgStore = connectPg(session);
    // Connection budget: this pool shares the Supabase Supavisor session-mode
    // pooler (pool_size: 15 project-wide) with DatabaseService's app pool and
    // the process-outbox cron job. Session reads/writes are cheap single-row
    // lookups, so a small cap is plenty — see the shared-budget comment on
    // DatabaseService's pool in database.service.ts for the full math. Left
    // unset, pg defaults `max` to 10, which alone was enough to blow the
    // budget and is what caused the EMAXCONNSESSION crashes.
    const sessionPool = new Pool({
      connectionString: appCfg.supabase.dbUrl,
      ssl: postgresSslConfig(appCfg.supabase.dbUrl, appCfg.supabase.dbCaCert),
      max: 2,
    });
    // pg emits 'error' on IDLE clients when the server or network drops them
    // out from under the pool (mirrors the handler on DatabaseService's pool).
    // Without this, a dropped idle client here throws unhandled and crashes
    // the process — every request passes through session middleware first,
    // so this pool's errors are the most likely source of an unhandled
    // exception reaching AllExceptionsFilter.
    sessionPool.on('error', (err) => {
      logger.warn(
        `Idle session-store Postgres client error (connection dropped, will be replaced): ${err.message}`,
      );
    });
    sessionStore = new PgStore({
      pool: sessionPool,
      tableName: 'session',
      createTableIfMissing: true,
    });
  }

  app.use(
    session({
      name: appCfg.session.name,
      secret: appCfg.session.secret,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        secure: appCfg.session.secure,
        // 'none' is required when the FE and BE are on different origins
        // (e.g. Vercel FE + Render BE). sameSite:'none' requires secure:true —
        // the conditional prevents the invalid none+insecure combination in dev.
        sameSite: appCfg.session.secure ? 'none' : 'lax',
        maxAge: appCfg.session.maxAgeMs,
        // When SESSION_COOKIE_DOMAIN is set (FE + BE on one parent domain), the
        // cookie is shared first-party across subdomains — required for Safari/iOS
        // login. Omitted by default → host-only cookie (current behavior).
        ...(appCfg.session.cookieDomain
          ? { domain: appCfg.session.cookieDomain }
          : {}),
      },
    }),
  );

  // Helmet — CISO-managed config (security.config.ts)
  app.use(helmet(enableSwagger ? helmetConfigSwagger : helmetConfig));

  // Body parsers with size limit (bodyParser disabled at factory level).
  // The verify callback captures the raw body buffer for webhook signature
  // verification — consumed once here before JSON parsing discards it.
  app.use(
    express.json({
      limit: BODY_SIZE_LIMIT,
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

  // Graceful shutdown
  app.enableShutdownHooks();

  // Global API prefix
  app.setGlobalPrefix('api/v1');

  // CORS — CISO-managed factory (security.config.ts)
  const allowedOriginsEnv = configService.get<string>('ALLOWED_ORIGINS');
  const allowedPatternsEnv = configService.get<string>(
    'ALLOWED_ORIGIN_PATTERNS',
  );
  app.enableCors(corsOptions(allowedOriginsEnv, allowedPatternsEnv));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger (conditional)
  if (enableSwagger) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Tribe Backend')
      .setDescription('Tribe Backend API')
      .setVersion('1.0.0')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/v1/docs', app, document);
    logger.log('Swagger docs available at /api/v1/docs');
  }

  const port = parseInt(process.env['PORT'] ?? '4000', 10);
  await app.listen(port, '0.0.0.0');
  logger.log(`Application running on 0.0.0.0:${String(port)}`);
}

void bootstrap();
