import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseService } from '#kernel/db/database.service';
import type { AssignmentConfig } from '#kernel/ports/onprem-assignment.port';
import {
  allowedDeploymentTransitions,
  toDeployment,
  type DeploymentRow,
  type DeploymentStatus,
} from './release-registry.repository';

export interface MachineAssignment {
  id: string;
  machineId: string;
  projectId: string;
  environmentId: string;
  revision: number;
  config: AssignmentConfig;
}
interface AssignmentRow {
  id: string;
  machine_id: string;
  project_id: string;
  environment_id: string;
  revision: number;
  assignment_config: AssignmentConfig;
  revoked_at: Date | null;
  name: string;
}
export interface LegacyHostAssignment {
  id: string;
  machineId: null;
  projectId: string;
  environmentId: string;
  revision: number;
  config: null;
  name: string;
}
const assignment = (row: AssignmentRow): MachineAssignment => ({
  id: row.id,
  machineId: row.machine_id,
  projectId: row.project_id,
  environmentId: row.environment_id,
  revision: row.revision,
  config: row.assignment_config,
});

@Injectable()
export class OnpremAssignmentsRepository {
  constructor(private readonly db: DatabaseService) {}
  async machineWorkspace(machineId: string): Promise<string | null> {
    const result = await this.db.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM env_provisioning.onprem_machines WHERE id=$1 AND revoked_at IS NULL',
      [machineId],
    );
    return result.rows[0]?.workspace_id ?? null;
  }
  async current(
    projectId: string,
    environmentId: string,
  ): Promise<MachineAssignment | LegacyHostAssignment | null> {
    const result = await this.db.query<AssignmentRow>(
      'SELECT * FROM env_provisioning.onprem_hosts WHERE project_id=$1 AND environment_id=$2 AND revoked_at IS NULL',
      [projectId, environmentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return row.machine_id
      ? assignment(row)
      : {
          id: row.id,
          machineId: null,
          projectId: row.project_id,
          environmentId: row.environment_id,
          revision: row.revision,
          config: null,
          name: row.name,
        };
  }
  async assign(input: {
    projectId: string;
    environmentId: string;
    workspaceId: string;
    userId: string;
    machineId: string;
    expectedAssignmentId: string | null;
    requestId: string;
    config: AssignmentConfig;
  }): Promise<MachineAssignment> {
    try {
      return await this.db.withTransaction(async (client) => {
        const machine = await client.query<{ id: string }>(
          'SELECT id FROM env_provisioning.onprem_machines WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE',
          [input.machineId, input.workspaceId],
        );
        if (!machine.rowCount)
          throw new NotFoundException(
            'Active machine not found in this workspace.',
          );
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          ['onprem-host:' + input.environmentId],
        );
        const replay = await client.query<AssignmentRow>(
          'SELECT * FROM env_provisioning.onprem_hosts WHERE project_id=$1 AND environment_id=$2 AND request_id=$3',
          [input.projectId, input.environmentId, input.requestId],
        );
        if (replay.rows[0]) {
          const row = replay.rows[0];
          if (
            row.revoked_at ||
            row.machine_id !== input.machineId ||
            !isDeepStrictEqual(row.assignment_config, input.config)
          )
            throw new ConflictException(
              'This assignment request has already been used. Reload the current assignment.',
            );
          return assignment(row);
        }
        const active = await client.query<{ id: string }>(
          'SELECT id FROM env_provisioning.onprem_hosts WHERE environment_id=$1 AND revoked_at IS NULL FOR UPDATE',
          [input.environmentId],
        );
        if ((active.rows[0]?.id ?? null) !== input.expectedAssignmentId)
          throw new ConflictException(
            'The host assignment changed. Reload it before replacing it.',
          );
        await client.query(
          'UPDATE env_provisioning.onprem_hosts SET revoked_at=NOW() WHERE environment_id=$1 AND revoked_at IS NULL',
          [input.environmentId],
        );
        const created = await client.query<AssignmentRow>(
          `INSERT INTO env_provisioning.onprem_hosts(project_id,environment_id,machine_id,name,created_by,assignment_config,request_id,revision)
        VALUES($1,$2,$3,'Machine assignment',$4,$5,$6,(SELECT COALESCE(MAX(revision),0)+1 FROM env_provisioning.onprem_hosts WHERE environment_id=$2)) RETURNING *`,
          [
            input.projectId,
            input.environmentId,
            input.machineId,
            input.userId,
            JSON.stringify(input.config),
            input.requestId,
          ],
        );
        const row = created.rows[0]!;
        for (const port of input.config.ports)
          await client.query(
            'INSERT INTO env_provisioning.onprem_port_reservations(machine_id,host_port,host_id) VALUES($1,$2,$3)',
            [input.machineId, port.hostPort, row.id],
          );
        return assignment(row);
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new ConflictException(
          'constraint' in error &&
            error.constraint === 'onprem_port_reservations_pkey'
            ? 'A host port is already reserved on this machine. Choose a different port.'
            : 'The host assignment changed. Reload and try again.',
        );
      throw error;
    }
  }
  async unassign(projectId: string, environmentId: string, expectedId: string) {
    await this.db.withTransaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['onprem-host:' + environmentId],
      );
      const result = await client.query(
        `UPDATE env_provisioning.onprem_hosts SET revoked_at=NOW() WHERE id=$1 AND project_id=$2 AND environment_id=$3 AND revoked_at IS NULL RETURNING id`,
        [expectedId, projectId, environmentId],
      );
      if (!result.rowCount)
        throw new ConflictException('The host assignment changed. Reload it.');
    });
  }
  async authorizeAgent(hash: string, kind: 'machine' | 'legacy') {
    return this.db.withTransaction(async (client) =>
      this.authorized(client, hash, kind),
    );
  }
  async withAuthorizedAgent<T>(
    hash: string,
    kind: 'machine' | 'legacy',
    read: (
      auth: Awaited<ReturnType<OnpremAssignmentsRepository['authorizeAgent']>>,
      client: PoolClient,
    ) => Promise<T>,
  ): Promise<T> {
    return this.db.withTransaction(async (client) =>
      read(await this.authorized(client, hash, kind), client),
    );
  }
  async reportStatus(
    hash: string,
    kind: 'machine' | 'legacy',
    deploymentId: string,
    status: DeploymentStatus,
    detail: string | null,
  ) {
    return this.db.withTransaction(async (client) => {
      const auth = await this.authorized(client, hash, kind);
      // The credential lock is held through binding validation and status commit.
      const result = await client.query<DeploymentRow>(
        `SELECT d.* FROM env_provisioning.environment_deployments d JOIN env_provisioning.onprem_hosts h ON h.environment_id=d.environment_id AND h.project_id=d.project_id
        WHERE d.id=$1 AND d.delivery='host' AND h.id=ANY($2::uuid[]) AND h.revoked_at IS NULL FOR UPDATE OF h,d`,
        [deploymentId, auth.assignmentIds],
      );
      const row = result.rows[0];
      if (!row)
        throw new NotFoundException(
          'Deployment not assigned to this credential.',
        );
      if (row.status === status) return toDeployment(row);
      if (!allowedDeploymentTransitions(row.status).includes(status))
        throw new ConflictException('Invalid deployment status transition.');
      const changed = await client.query<DeploymentRow>(
        'UPDATE env_provisioning.environment_deployments SET status=$2,detail=$3,updated_at=NOW() WHERE id=$1 RETURNING *',
        [deploymentId, status, detail],
      );
      return toDeployment(changed.rows[0]!);
    });
  }
  private async authorized(
    client: PoolClient,
    hash: string,
    kind: 'machine' | 'legacy',
  ) {
    let machineId: string | null = null;
    if (kind === 'machine') {
      const found = await client.query<{ id: string }>(
        'SELECT id FROM env_provisioning.onprem_machines WHERE token_sha256=$1 AND revoked_at IS NULL FOR UPDATE',
        [hash],
      );
      machineId = found.rows[0]?.id ?? null;
      if (!machineId)
        throw new UnauthorizedException(
          'Machine credential is invalid or revoked.',
        );
    }
    const bindings = await client.query<AssignmentRow>(
      `SELECT * FROM env_provisioning.onprem_hosts WHERE revoked_at IS NULL AND ${kind === 'machine' ? 'machine_id=$1' : 'token_sha256=$1'} ORDER BY id FOR UPDATE`,
      [machineId ?? hash],
    );
    if (kind === 'legacy' && !bindings.rowCount)
      throw new UnauthorizedException('Host credential is invalid or revoked.');
    return {
      kind,
      machineId,
      assignmentIds: bindings.rows.map((row) => row.id),
      bindings: bindings.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        environmentId: row.environment_id,
        machine: row.machine_id ? assignment(row) : null,
      })),
    };
  }
}
