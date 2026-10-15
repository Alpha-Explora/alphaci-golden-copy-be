import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { DatabaseService } from '../../src/kernel/db/database.service';
import type { AssignmentConfig } from '../../src/kernel/ports/onprem-assignment.port';
import {
  ONPREM_PORT_RANGE,
  OnpremAssignmentsRepository,
  type MachineAssignment,
} from '../../src/modules/runtime/infrastructure/repositories/onprem-assignments.repository';
import { OnpremMachinesRepository } from '../../src/modules/runtime/infrastructure/repositories/onprem-machines.repository';
import { ReleaseRegistryRepository } from '../../src/modules/runtime/infrastructure/repositories/release-registry.repository';
import { hashMachineSecret } from '../../src/modules/runtime/application/onprem/onprem-hosts.service';

describe('Reusable machine assignment authorization', () => {
  const pool = new Pool({
    connectionString: process.env['E2E_APP_DATABASE_URL'],
  });
  const db = {
    query: pool.query.bind(pool),
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
  const assignments = new OnpremAssignmentsRepository(db),
    machines = new OnpremMachinesRepository(db),
    releases = new ReleaseRegistryRepository(db);
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    hash = hashMachineSecret(randomUUID());
  let machineId: string,
    projectId: string,
    environmentId: string,
    secondEnv: string;
  const config: AssignmentConfig = {
    ports: [{ slot: 'frontend', hostPort: 18200, containerPort: 3000 }],
    health: [{ slot: 'frontend', path: '/' }],
    ingress: { mode: 'direct', publicUrl: null },
  };
  const input = () => ({
    projectId,
    environmentId,
    workspaceId,
    userId,
    machineId,
    expectedAssignmentId: null,
    requestId: randomUUID(),
    config,
  });
  beforeAll(async () => {
    await pool.query(
      'INSERT INTO identity.app_users(id,login,github_user_id) VALUES($1::uuid,$1::text,$1::text)',
      [userId],
    );
    projectId = (
      await pool.query<{ id: string }>(
        `INSERT INTO projects.provisioned_projects(user_id,repo_full_name,template_id,service_name,workflow_path,status) VALUES($1,$2,'fe-nextjs','web','.github/workflows/ci.yml','provisioned') RETURNING id`,
        [userId, 'e2e/' + randomUUID()],
      )
    ).rows[0]!.id;
    for (const [position, slug] of ['dev', 'uat'].entries()) {
      const id = (
        await pool.query<{ id: string }>(
          `INSERT INTO projects.project_environments(project_id,slug,display_name,position,source_branch,role,auto_deploy) VALUES($1,$2,$2,$3,$2,'non_production',$4) RETURNING id`,
          [projectId, slug, position, position === 0],
        )
      ).rows[0]!.id;
      if (position === 0) environmentId = id;
      else secondEnv = id;
    }
    const code = hashMachineSecret(randomUUID());
    await machines.createEnrollment(
      workspaceId,
      userId,
      { name: 'shared', platform: 'ubuntu', requestId: randomUUID() },
      code,
    );
    machineId = (
      await machines.consume(code, hash, 'prefix', {
        agentVersion: 'test',
        checks: [],
      })
    ).id;
  });
  afterAll(async () => {
    await pool.query(
      'DELETE FROM env_provisioning.environment_deployments WHERE project_id=$1',
      [projectId],
    );
    await pool.query(
      'DELETE FROM env_provisioning.onprem_hosts WHERE project_id=$1',
      [projectId],
    );
    await pool.query(
      'DELETE FROM env_provisioning.releases WHERE project_id=$1',
      [projectId],
    );
    await pool.query(
      'DELETE FROM env_provisioning.onprem_enrollments WHERE workspace_id=$1',
      [workspaceId],
    );
    await pool.query(
      'DELETE FROM env_provisioning.onprem_machines WHERE workspace_id=$1',
      [workspaceId],
    );
    await pool.query(
      'DELETE FROM env_provisioning.onprem_workspace_lifecycle WHERE workspace_id=$1',
      [workspaceId],
    );
    await pool.query('DELETE FROM projects.provisioned_projects WHERE id=$1', [
      projectId,
    ]);
    await pool.query('DELETE FROM identity.app_users WHERE id=$1', [userId]);
    await pool.end();
  });
  it('uses compare-and-set, replays the same request once, and allocates distinct host ports', async () => {
    const request = input();
    const result = await Promise.allSettled([
      assignments.assign(request),
      assignments.assign({ ...request, requestId: randomUUID() }),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const current = (await assignments.current(projectId, environmentId))!;
    if (result[0]?.status === 'fulfilled')
      expect((await assignments.assign(request)).id).toBe(current.id);
    // The client's hostPort is ignored: the server picks free ports.
    const first = (current as MachineAssignment).config.ports[0]!.hostPort;
    expect(first).toBeGreaterThanOrEqual(ONPREM_PORT_RANGE.first);
    const other = await assignments.assign({
      ...input(),
      environmentId: secondEnv,
    });
    expect(other.config.ports[0]!.hostPort).not.toBe(first);
    await assignments.unassign(projectId, secondEnv, other.id);
    await assignments.unassign(projectId, environmentId, current.id);
    const bound = await assignments.assign({
      ...input(),
      environmentId: secondEnv,
    });
    await expect(
      assignments.assign({ ...input(), environmentId: secondEnv }),
    ).rejects.toThrow(/changed/);
    await assignments.unassign(projectId, secondEnv, bound.id);
  });
  it('denies cross-workspace machine binding and forged deployment status', async () => {
    await expect(
      assignments.assign({ ...input(), workspaceId: randomUUID() }),
    ).rejects.toThrow(/workspace/);
    await expect(
      assignments.reportStatus(
        hash,
        'machine',
        randomUUID(),
        'deploying',
        null,
      ),
    ).rejects.toThrow(/not assigned/);
  });
  it('serializes legacy registration against machine replacement, retaining exactly one active binding', async () => {
    const result = await Promise.allSettled([
      assignments.assign(input()),
      releases.createHost({
        projectId,
        environmentId,
        name: 'legacy',
        tokenPrefix: 'aoh_',
        tokenSha256: hashMachineSecret(randomUUID()),
        createdBy: userId,
      }),
    ]);
    expect(
      result.filter((item) => item.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    const active = await pool.query<{ id: string }>(
      'SELECT id FROM env_provisioning.onprem_hosts WHERE environment_id=$1 AND revoked_at IS NULL',
      [environmentId],
    );
    expect(active.rows).toHaveLength(1);
    await assignments.unassign(projectId, environmentId, active.rows[0]!.id);
  });
  it('holds the machine lock until assignment reads finish', async () => {
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const read = assignments.withAuthorizedAgent(hash, 'machine', async () => {
      enter();
      await gate;
      return 'read';
    });
    await entered;
    try {
      await expect(
        pool.query(
          'SELECT id FROM env_provisioning.onprem_machines WHERE id=$1 FOR UPDATE NOWAIT',
          [machineId],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      finish();
    }
    expect(await read).toBe('read');
  });
  it('picks the only healthy machine and keeps host ports when reassigned on it', async () => {
    const auto = await assignments.assign({ ...input(), machineId: null });
    expect(auto.machineId).toBe(machineId);
    expect(
      (await machines.heartbeat(hash, { agentVersion: 'test', checks: [] }))
        .ports,
    ).toEqual(auto.config.ports.map((port) => port.hostPort));
    const changed = await assignments.assign({
      ...input(),
      machineId: null,
      expectedAssignmentId: auto.id,
      config: { ...config, health: [{ slot: 'frontend', path: '/ready' }] },
    });
    expect(changed.config.ports).toEqual(auto.config.ports);
    expect(changed.revision).toBe(auto.revision + 1);
    await assignments.unassign(projectId, environmentId, changed.id);
  });
  it('moves active bindings to a replacement machine with the same ports', async () => {
    const enroll = async (replacesMachineId?: string) => {
      const code = hashMachineSecret(randomUUID());
      await machines.createEnrollment(
        workspaceId,
        userId,
        {
          name: 'swap',
          platform: 'ubuntu',
          requestId: randomUUID(),
          replacesMachineId,
        },
        code,
      );
      return (
        await machines.consume(code, hashMachineSecret(randomUUID()), 'p', {
          agentVersion: 'test',
          checks: [],
        })
      ).id;
    };
    const old = await enroll();
    // Two healthy machines: a person must choose.
    await expect(
      assignments.assign({ ...input(), machineId: null }),
    ).rejects.toThrow(/Choose the machine/);
    const bound = await assignments.assign({
      ...input(),
      environmentId: secondEnv,
      machineId: old,
    });
    const replacement = await enroll(old);
    const moved = (await assignments.current(
      projectId,
      secondEnv,
    )) as MachineAssignment;
    expect(moved.machineId).toBe(replacement);
    expect(moved.id).not.toBe(bound.id);
    expect(moved.config).toEqual(bound.config);
    const reserved = await pool.query<{ machine_id: string }>(
      'SELECT machine_id FROM env_provisioning.onprem_port_reservations WHERE host_id=$1',
      [moved.id],
    );
    expect(reserved.rows).toEqual([{ machine_id: replacement }]);
    // Revoking with a replacement moves them as well.
    await machines.revoke(workspaceId, replacement, machineId);
    const back = (await assignments.current(
      projectId,
      secondEnv,
    )) as MachineAssignment;
    expect(back.machineId).toBe(machineId);
    await assignments.unassign(projectId, secondEnv, back.id);
  });
  it('holds credential authority through a status transaction, then denies revoked credentials', async () => {
    await assignments.assign(input());
    const release = await pool.query<{ id: string }>(
      `INSERT INTO env_provisioning.releases(project_id,source_environment_id,source_branch,commit_sha,workflow_provider,workflow_repo,workflow_run_id,workflow_run_url)
      VALUES($1,$2,'dev',$3,'github_actions','e2e/race','1','https://github.com/e2e/race/actions/runs/1') RETURNING id`,
      [projectId, environmentId, 'a'.repeat(40)],
    );
    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO env_provisioning.environment_deployments(project_id,environment_id,release_id,trigger,delivery) VALUES($1,$2,$3,'automatic','host') RETURNING id`,
      [projectId, environmentId, release.rows[0]!.id],
    );
    const deploymentId = deployment.rows[0]!.id;
    const race = await Promise.allSettled([
      assignments.reportStatus(
        hash,
        'machine',
        deploymentId,
        'deploying',
        null,
      ),
      machines.revoke(workspaceId, machineId),
    ]);
    expect(race[1]?.status).toBe('fulfilled');
    const stored = await pool.query<{ status: string }>(
      'SELECT status FROM env_provisioning.environment_deployments WHERE id=$1',
      [deploymentId],
    );
    expect(stored.rows[0]!.status).toBe(
      race[0]?.status === 'fulfilled' ? 'deploying' : 'pending',
    );
    await expect(assignments.authorizeAgent(hash, 'machine')).rejects.toThrow(
      /revoked/,
    );
    await expect(
      machines.heartbeat(hash, { agentVersion: 'test', checks: [] }),
    ).rejects.toThrow(/revoked/);
    await expect(
      assignments.reportStatus(hash, 'machine', deploymentId, 'healthy', null),
    ).rejects.toThrow(/revoked/);
    await pool.query(
      readFileSync(
        resolve('supabase/rollbacks/20261015020000_onprem_machines_down.sql'),
        'utf8',
      ),
    );
    await pool.query(
      readFileSync(
        resolve(
          'supabase/migrations/runtime/20261015020000_onprem_machines.sql',
        ),
        'utf8',
      ),
    );
    await expect(assignments.authorizeAgent(hash, 'machine')).rejects.toThrow(
      /revoked/,
    );
  });
});
