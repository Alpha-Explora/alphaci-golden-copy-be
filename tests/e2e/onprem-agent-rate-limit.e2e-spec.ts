import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import type { DatabaseService } from '../../src/kernel/db/database.service';
import {
  hashMachineSecret,
  MACHINE_TOKEN_PREFIX,
} from '../../src/modules/runtime/application/onprem/onprem-hosts.service';
import { ONPREM_MACHINE_RATE_LIMIT } from '../../src/modules/runtime/api/onprem-machine-throttler.guard';
import { OnpremMachinesRepository } from '../../src/modules/runtime/infrastructure/repositories/onprem-machines.repository';
import { startApplication, type E2eApplication } from './support/application';

describe('Per-machine rate limits on agent endpoints', () => {
  const pool = new Pool({
    connectionString: process.env['E2E_APP_DATABASE_URL'],
  });
  const db = {
    query: pool.query.bind(pool),
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
  const machines = new OnpremMachinesRepository(db);
  const workspaceId = randomUUID();
  const checkIn = { agentVersion: 'test', checks: [] };
  const { limit } = ONPREM_MACHINE_RATE_LIMIT;
  let e2e: E2eApplication;
  let previousOnpremFlag: string | undefined;

  /** Enrolls and consumes a machine through the repository; returns its bearer credential. */
  async function enrollMachine(): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const credential =
      MACHINE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    await machines.createEnrollment(
      workspaceId,
      randomUUID(),
      { name: 'rate limited', platform: 'ubuntu', requestId: randomUUID() },
      hashMachineSecret(code),
    );
    await machines.consume(
      hashMachineSecret(code),
      hashMachineSecret(credential),
      credential.slice(0, 22),
      checkIn,
    );
    return credential;
  }
  const heartbeat = (credential: string) =>
    request(e2e.http)
      .post('/api/v1/onprem/heartbeat')
      .set('Authorization', `Bearer ${credential}`)
      .send(checkIn);

  beforeAll(async () => {
    previousOnpremFlag = process.env['ONPREM_RELEASES_ENABLED'];
    process.env['ONPREM_RELEASES_ENABLED'] = 'true';
    e2e = await startApplication();
  });
  afterAll(async () => {
    await e2e.close();
    await pool.end();
    if (previousOnpremFlag === undefined) {
      delete process.env['ONPREM_RELEASES_ENABLED'];
    } else {
      process.env['ONPREM_RELEASES_ENABLED'] = previousOnpremFlag;
    }
  });

  it('limits each machine on its own, so machines behind one IP do not share a bucket', async () => {
    const first = await enrollMachine();
    const second = await enrollMachine();
    // supertest reaches the app from one loopback address for both machines.
    for (let sent = 0; sent < limit; sent++) await heartbeat(first).expect(201);
    await heartbeat(first).expect(429);
    await heartbeat(second).expect(201);
  });

  it('keeps unknown credentials on the client IP, so rotating tokens opens no new bucket', async () => {
    for (let sent = 0; sent < limit; sent++)
      await heartbeat(
        MACHINE_TOKEN_PREFIX + randomBytes(32).toString('base64url'),
      ).expect(401);
    await heartbeat(
      MACHINE_TOKEN_PREFIX + randomBytes(32).toString('base64url'),
    ).expect(429);
  });
});
