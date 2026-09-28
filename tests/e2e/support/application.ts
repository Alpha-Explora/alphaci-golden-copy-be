import type { AddressInfo } from 'node:net';

import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import type { AppConfig } from '#kernel/config/app.config';
import { CI_PROJECT_PORT } from '#kernel/ports/ci-project.port';
import { GITHUB_PROJECT_PORT } from '#kernel/ports/github.port';
import { AppModule } from '../../../src/app.module';
import { configureHttpApplication } from '../../../src/main';
import { GITHUB_ACTIONS_SECRETS } from '../../../src/modules/runtime/application/ports/github-actions-secrets.port';
import { PROVIDER_CLIENT_REGISTRY } from '../../../src/modules/runtime/application/ports/provider-client-registry.port';
import { withClient } from './database';
import { recordingPort, type RecordedCall } from './recording-port';

export type HttpServer = Parameters<typeof request>[0];
export type SignedInAgent = ReturnType<typeof request.agent>;

export interface E2eApplication {
  http: HttpServer;
  databaseUrl: string;
  /** Calls that reached a faked external provider port. */
  externalCalls: RecordedCall[];
  /** Scenario controls for the faked providers. */
  providers: {
    /** Make GitHub Environment provisioning fail until reset. */
    failGithubEnvironments(fail: boolean): void;
    /** Make GitHub workflow dispatch fail until reset. */
    failWorkflowDispatch(fail: boolean): void;
  };
  /** Sign in through the real loopback quick-login session flow. */
  signIn(): Promise<{ agent: SignedInAgent; userId: string }>;
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Listen on all interfaces so a container can reach the API; returns the port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

const QUICK_LOGIN_GITHUB_USER_ID = 'alphaci-local-dev-quick-login';

// Synchronous GitHub port members read during module construction.
const GITHUB_SYNC_MEMBERS = {
  silent: {
    getEnforcedOrg: () => 'e2e-org',
    onRepositoryDeleted: () => undefined,
    onTeamMembershipChanged: () => undefined,
  },
};

/**
 * Boot the real AppModule and HTTP middleware against the E2E database. Only
 * external provider ports are replaced, with recording fakes.
 */
export async function startApplication(
  options: {
    /** Extra GitHub port calls a scenario expects, recorded then answered. */
    githubAnswers?: Record<string, (...args: unknown[]) => unknown>;
    /** Extra CI port calls a scenario expects, recorded then answered. */
    ciAnswers?: Record<string, (...args: unknown[]) => unknown>;
  } = {},
): Promise<E2eApplication> {
  const databaseUrl = process.env['E2E_APP_DATABASE_URL'] ?? '';
  const externalCalls: RecordedCall[] = [];
  let githubEnvironmentsFail = false;
  let workflowDispatchFails = false;
  let providerTargets = 0;

  const githubActions = recordingPort('githubActions', externalCalls, {
    answers: {
      setActionsSecretStrict: () => Promise.resolve(),
      setActionsVariableStrict: () => Promise.resolve(),
      ensureDeploymentEnvironment: () =>
        githubEnvironmentsFail
          ? Promise.reject(
              new BadGatewayException('E2E: GitHub rejected the environment.'),
            )
          : Promise.resolve(),
      dispatchWorkflow: () =>
        workflowDispatchFails
          ? Promise.reject(
              new BadGatewayException('E2E: GitHub refused the dispatch.'),
            )
          : Promise.resolve(),
    },
  });
  const providerClients = {
    getClient: (provider: string) =>
      recordingPort('provider:' + provider, externalCalls, {
        answers: {
          createTarget: (input) => {
            providerTargets += 1;
            return Promise.resolve({
              id: 'e2e-' + provider + '-' + String(providerTargets),
              name: (input as { projectName: string }).projectName,
              provider,
              metadata: {},
            });
          },
        },
      }),
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GITHUB_PROJECT_PORT)
    .useValue(
      recordingPort('github', externalCalls, {
        ...GITHUB_SYNC_MEMBERS,
        answers: options.githubAnswers ?? {},
      }),
    )
    .overrideProvider(CI_PROJECT_PORT)
    .useValue(
      recordingPort('ci', externalCalls, { answers: options.ciAnswers ?? {} }),
    )
    .overrideProvider(GITHUB_ACTIONS_SECRETS)
    .useValue(githubActions)
    .overrideProvider(PROVIDER_CLIENT_REGISTRY)
    .useValue(providerClients)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureHttpApplication(app);
  await app.init();

  const configuredUrl = app.get(ConfigService).get<AppConfig>('app')
    ?.supabase.dbUrl;
  if (!databaseUrl || configuredUrl !== databaseUrl) {
    await app.close();
    throw new Error('E2E app is not connected to the disposable database.');
  }

  const http = app.getHttpServer() as HttpServer;
  const query = <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ) =>
    withClient(databaseUrl, async (client) => {
      const result = await client.query<T>(sql, params);
      return result.rows;
    });

  return {
    http,
    databaseUrl,
    externalCalls,
    providers: {
      failGithubEnvironments(fail) {
        githubEnvironmentsFail = fail;
      },
      failWorkflowDispatch(fail) {
        workflowDispatchFails = fail;
      },
    },
    query,
    async listen() {
      await app.listen(0, '0.0.0.0');
      return (app.getHttpServer() as { address(): AddressInfo }).address().port;
    },
    async signIn() {
      const agent = request.agent(http);
      await agent.post('/api/v1/auth/dev/quick-login').expect(201);
      const [user] = await query<{ id: string }>(
        'SELECT id FROM identity.app_users WHERE github_user_id = $1',
        [QUICK_LOGIN_GITHUB_USER_ID],
      );
      if (!user) throw new Error('Quick login did not create its user.');
      return { agent, userId: user.id };
    },
    close: () => app.close(),
  };
}
