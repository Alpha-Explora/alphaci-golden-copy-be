import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { DatabaseService } from '../../src/kernel/db/database.service';
import { OnpremMachinesRepository } from '../../src/modules/runtime/infrastructure/repositories/onprem-machines.repository';
import { hashMachineSecret } from '../../src/modules/runtime/application/onprem/onprem-hosts.service';

describe('One-time machine enrollment and revocation', () => {
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
  const repository = new OnpremMachinesRepository(db);
  const workspaces: string[] = [];
  const checkIn = { agentVersion: 'test', checks: [] };
  async function enroll(replacesMachineId?: string) {
    const workspaceId = workspaces[0] ?? randomUUID();
    if (!workspaces.length) workspaces.push(workspaceId);
    const code = randomUUID(),
      requestId = randomUUID();
    const input = {
      name: 'test host',
      platform: 'ubuntu' as const,
      requestId,
      ...(replacesMachineId ? { replacesMachineId } : {}),
    };
    const receipt = await repository.createEnrollment(
      workspaceId,
      randomUUID(),
      input,
      hashMachineSecret(code),
    );
    return { code, workspaceId, requestId, input, receipt };
  }
  afterAll(async () => {
    for (const workspace of workspaces) {
      await pool.query(
        'DELETE FROM env_provisioning.onprem_enrollments WHERE workspace_id=$1',
        [workspace],
      );
      await pool.query(
        'DELETE FROM env_provisioning.onprem_machines WHERE workspace_id=$1',
        [workspace],
      );
      await pool.query(
        'DELETE FROM env_provisioning.onprem_workspace_lifecycle WHERE workspace_id=$1',
        [workspace],
      );
    }
    await pool.end();
  });
  it('concurrent consumers produce exactly one credential and cannot replay a lost response', async () => {
    const { code } = await enroll();
    const results = await Promise.allSettled(
      ['token-a', 'token-b'].map((token) =>
        repository.consume(
          hashMachineSecret(code),
          hashMachineSecret(token),
          'prefix',
          checkIn,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    await expect(
      repository.consume(
        hashMachineSecret(code),
        hashMachineSecret('retry'),
        'prefix',
        checkIn,
      ),
    ).rejects.toThrow(/already consumed/);
    const stored = await pool.query(
      'SELECT code_sha256 FROM env_provisioning.onprem_enrollments WHERE code_sha256=$1',
      [hashMachineSecret(code)],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(code);
  });
  it('expires after ten minutes, and a request-id retry cannot make another enrollment', async () => {
    const { code, receipt, workspaceId, input } = await enroll();
    await expect(
      repository.createEnrollment(
        workspaceId,
        randomUUID(),
        input,
        hashMachineSecret('another'),
      ),
    ).rejects.toThrow(/already exists/);
    await pool.query(
      "UPDATE env_provisioning.onprem_enrollments SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [receipt.id],
    );
    await expect(
      repository.consume(
        hashMachineSecret(code),
        hashMachineSecret('expired'),
        'prefix',
        checkIn,
      ),
    ).rejects.toThrow(/expired/);
  });
  it('rotation revokes only the explicitly named machine, and revoked heartbeat stays denied', async () => {
    const { code, workspaceId } = await enroll();
    const first = await repository.consume(
      hashMachineSecret(code),
      hashMachineSecret('first-token'),
      'prefix',
      checkIn,
    );
    const secondEnrollment = await enroll(first.id);
    const second = await repository.consume(
      hashMachineSecret(secondEnrollment.code),
      hashMachineSecret('second-token'),
      'prefix',
      checkIn,
    );
    expect(second.id).not.toBe(first.id);
    await expect(
      repository.heartbeat(hashMachineSecret('first-token'), checkIn),
    ).rejects.toThrow(/revoked/);
    await repository.heartbeat(hashMachineSecret('second-token'), checkIn);
    await pool.query(
      "UPDATE env_provisioning.onprem_machines SET last_seen_at=NOW()-INTERVAL '91 seconds' WHERE id=$1",
      [second.id],
    );
    expect(
      (await repository.list(workspaceId)).find(
        (machine) => machine.id === second.id,
      )?.status,
    ).toBe('offline');
    await repository.revoke(workspaceId, second.id);
    await expect(
      repository.heartbeat(hashMachineSecret('second-token'), checkIn),
    ).rejects.toThrow(/revoked/);
  });
  it('workspace deletion expires codes, revokes credentials and blocks concurrent new enrollment', async () => {
    const { workspaceId, code } = await enroll();
    await repository.purgeWorkspace(workspaceId);
    await expect(
      repository.consume(
        hashMachineSecret(code),
        hashMachineSecret('orphan'),
        'prefix',
        checkIn,
      ),
    ).rejects.toThrow(/deleted/);
    await expect(
      repository.createEnrollment(
        workspaceId,
        randomUUID(),
        { name: 'orphan', platform: 'ubuntu', requestId: randomUUID() },
        hashMachineSecret('orphan'),
      ),
    ).rejects.toThrow(/deleted/);
  });
});
