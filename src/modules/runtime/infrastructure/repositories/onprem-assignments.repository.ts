import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseService } from '#kernel/db/database.service';
import type {
  AssignmentConfig,
  AssignmentRequestConfig,
  TunnelReport,
  TunnelStatus,
} from '#kernel/ports/onprem-assignment.port';
import {
  TUNNEL_REPORT_WINDOW,
  effectivePublicAddress,
  tunnelReady,
  tunnelReport,
} from '../../domain/onprem-tunnel';
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
  created_by: string | null;
  tunnel_status: TunnelStatus | null;
  tunnel_url: string | null;
  tunnel_message: string | null;
  tunnel_reported_at: Date | null;
  tunnel_fresh?: boolean;
}
/** A machine assignment as the API presents it: `tunnel` only in tunnel mode. */
export type CurrentMachineAssignment = MachineAssignment & {
  tunnel: TunnelReport | null;
};
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

/** Host ports AlphaCI hands out on a machine, lowest free first. */
export const ONPREM_PORT_RANGE = { first: 8080, last: 8999 } as const;
/** A machine is healthy while its supervisor checks in (every 30 seconds). */
export const HEALTHY_MACHINE = `revoked_at IS NULL AND last_seen_at > NOW() - INTERVAL '90 seconds'`;

/** The part of a config a client chooses: everything except host ports. */
export const requestedConfig = (
  config: AssignmentConfig | AssignmentRequestConfig,
): AssignmentRequestConfig => ({
  ports: config.ports.map(({ slot, containerPort }) => ({
    slot,
    containerPort,
  })),
  health: config.health,
  ingress: config.ingress,
});

/**
 * Reserve one host port per slot for a binding on a machine whose row the
 * caller holds FOR UPDATE, so allocations on one machine never race. A slot
 * keeps its preferred port while that is still free there.
 */
export async function reserveMachinePorts(
  client: PoolClient,
  machineId: string,
  hostId: string,
  config: AssignmentRequestConfig,
  preferred: ReadonlyMap<string, number> = new Map(),
): Promise<AssignmentConfig> {
  const reserved = await client.query<{ host_port: number }>(
    'SELECT host_port FROM env_provisioning.onprem_port_reservations WHERE machine_id=$1',
    [machineId],
  );
  const taken = new Set(reserved.rows.map((row) => row.host_port));
  const ports: AssignmentConfig['ports'] = [];
  for (const port of config.ports) {
    let hostPort = preferred.get(port.slot);
    if (hostPort === undefined || taken.has(hostPort)) {
      hostPort = undefined;
      for (
        let next = ONPREM_PORT_RANGE.first;
        next <= ONPREM_PORT_RANGE.last;
        next++
      )
        if (!taken.has(next)) {
          hostPort = next;
          break;
        }
    }
    if (hostPort === undefined)
      throw new ConflictException(
        'No free host ports remain on this machine. Unassign an environment or use another machine.',
      );
    taken.add(hostPort);
    ports.push({
      slot: port.slot,
      hostPort,
      containerPort: port.containerPort,
    });
    await client.query(
      'INSERT INTO env_provisioning.onprem_port_reservations(machine_id,host_port,host_id) VALUES($1,$2,$3)',
      [machineId, hostPort, hostId],
    );
  }
  const stored = { ...requestedConfig(config), ports };
  await client.query(
    'UPDATE env_provisioning.onprem_hosts SET assignment_config=$2 WHERE id=$1',
    [hostId, JSON.stringify(stored)],
  );
  return stored;
}

/**
 * Move every active binding of a retired machine to its replacement, keeping
 * host ports where the replacement has them free. Each move is a new revision
 * of that environment, so agents and history see an ordinary reassignment.
 * The caller holds both machine rows FOR UPDATE.
 */
export async function moveMachineBindings(
  client: PoolClient,
  fromMachineId: string,
  toMachineId: string,
): Promise<number> {
  const bindings = await client.query<AssignmentRow>(
    'SELECT * FROM env_provisioning.onprem_hosts WHERE machine_id=$1 AND revoked_at IS NULL ORDER BY environment_id FOR UPDATE',
    [fromMachineId],
  );
  for (const row of bindings.rows) {
    // Revoking releases the old machine's port reservations (trigger).
    await client.query(
      'UPDATE env_provisioning.onprem_hosts SET revoked_at=NOW() WHERE id=$1',
      [row.id],
    );
    const created = await insertBinding(client, {
      projectId: row.project_id,
      environmentId: row.environment_id,
      machineId: toMachineId,
      userId: row.created_by,
      requestId: null,
      config: row.assignment_config,
    });
    await reserveMachinePorts(
      client,
      toMachineId,
      created.id,
      row.assignment_config,
      new Map(
        row.assignment_config.ports.map((port) => [port.slot, port.hostPort]),
      ),
    );
  }
  return bindings.rowCount ?? 0;
}

/**
 * End every active binding of a machine revoked without a replacement, so its
 * environments can be assigned or registered again without an Unassign. The
 * revoked_at trigger releases the reserved host ports. The caller holds the
 * machine row FOR UPDATE.
 */
export async function endMachineBindings(
  client: PoolClient,
  machineId: string,
): Promise<number> {
  const ended = await client.query(
    'UPDATE env_provisioning.onprem_hosts SET revoked_at=NOW() WHERE machine_id=$1 AND revoked_at IS NULL',
    [machineId],
  );
  return ended.rowCount ?? 0;
}

async function insertBinding(
  client: PoolClient,
  input: {
    projectId: string;
    environmentId: string;
    machineId: string;
    userId: string | null;
    requestId: string | null;
    config: AssignmentRequestConfig;
  },
) {
  const created = await client.query<AssignmentRow>(
    `INSERT INTO env_provisioning.onprem_hosts(project_id,environment_id,machine_id,name,created_by,assignment_config,request_id,revision)
    VALUES($1,$2,$3,'Machine assignment',$4,$5,COALESCE($6::uuid,gen_random_uuid()),(SELECT COALESCE(MAX(revision),0)+1 FROM env_provisioning.onprem_hosts WHERE environment_id=$2)) RETURNING *`,
    [
      input.projectId,
      input.environmentId,
      input.machineId,
      input.userId,
      JSON.stringify(requestedConfig(input.config)),
      input.requestId,
    ],
  );
  return created.rows[0]!;
}

@Injectable()
export class OnpremAssignmentsRepository {
  constructor(private readonly db: DatabaseService) {}
  /** Healthy machines of a workspace, oldest first. */
  async healthyMachines(workspaceId: string): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM env_provisioning.onprem_machines WHERE workspace_id=$1 AND ${HEALTHY_MACHINE} ORDER BY created_at, id`,
      [workspaceId],
    );
    return result.rows.map((row) => row.id);
  }
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
  ): Promise<CurrentMachineAssignment | LegacyHostAssignment | null> {
    const result = await this.db.query<AssignmentRow>(
      `SELECT *, tunnel_reported_at > NOW() - INTERVAL '${TUNNEL_REPORT_WINDOW}' AS tunnel_fresh
         FROM env_provisioning.onprem_hosts WHERE project_id=$1 AND environment_id=$2 AND revoked_at IS NULL`,
      [projectId, environmentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return row.machine_id
      ? {
          ...assignment(row),
          tunnel:
            row.assignment_config.ingress.mode === 'tunnel'
              ? tunnelReport({
                  status: row.tunnel_status,
                  url: row.tunnel_url,
                  message: row.tunnel_message,
                  reportedAt: row.tunnel_reported_at,
                  fresh: row.tunnel_fresh === true,
                })
              : null,
        }
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
    /** null: the workspace's only healthy machine. */
    machineId: string | null;
    expectedAssignmentId: string | null;
    requestId: string;
    config: AssignmentRequestConfig;
  }): Promise<MachineAssignment> {
    try {
      return await this.db.withTransaction(async (client) => {
        const machineId = await this.lockMachine(
          client,
          input.workspaceId,
          input.machineId,
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
            (input.machineId !== null && row.machine_id !== input.machineId) ||
            !isDeepStrictEqual(
              requestedConfig(row.assignment_config),
              requestedConfig(input.config),
            )
          )
            throw new ConflictException(
              'This assignment request has already been used. Reload the current assignment.',
            );
          return assignment(row);
        }
        const active = await client.query<AssignmentRow>(
          'SELECT * FROM env_provisioning.onprem_hosts WHERE environment_id=$1 AND revoked_at IS NULL FOR UPDATE',
          [input.environmentId],
        );
        const previous = active.rows[0] ?? null;
        if ((previous?.id ?? null) !== input.expectedAssignmentId)
          throw new ConflictException(
            'The host assignment changed. Reload it before replacing it.',
          );
        // Revoking releases the previous reservations, so a reassignment on
        // the same machine keeps each slot's host port.
        await client.query(
          'UPDATE env_provisioning.onprem_hosts SET revoked_at=NOW() WHERE environment_id=$1 AND revoked_at IS NULL',
          [input.environmentId],
        );
        const row = await insertBinding(client, { ...input, machineId });
        const config = await reserveMachinePorts(
          client,
          machineId,
          row.id,
          input.config,
          new Map(
            previous?.machine_id === machineId
              ? previous.assignment_config.ports.map((port) => [
                  port.slot,
                  port.hostPort,
                ])
              : [],
          ),
        );
        return assignment({ ...row, assignment_config: config });
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new ConflictException(
          'The host assignment changed. Reload and try again.',
        );
      throw error;
    }
  }
  private async lockMachine(
    client: PoolClient,
    workspaceId: string,
    machineId: string | null,
  ): Promise<string> {
    if (machineId) {
      const machine = await client.query<{ id: string }>(
        'SELECT id FROM env_provisioning.onprem_machines WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL FOR UPDATE',
        [machineId, workspaceId],
      );
      if (!machine.rowCount)
        throw new NotFoundException(
          'Active machine not found in this workspace.',
        );
      return machineId;
    }
    const healthy = await client.query<{ id: string }>(
      `SELECT id FROM env_provisioning.onprem_machines WHERE workspace_id=$1 AND ${HEALTHY_MACHINE} ORDER BY created_at, id FOR UPDATE`,
      [workspaceId],
    );
    if (!healthy.rows[0])
      throw new BadRequestException(
        'No connected on-prem machine is available. Enroll a machine or bring one online, then assign.',
      );
    if (healthy.rows.length > 1)
      throw new BadRequestException(
        'Several on-prem machines are connected. Choose the machine for this environment.',
      );
    return healthy.rows[0].id;
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
    let agentVersion: string | null = null;
    if (kind === 'machine') {
      const found = await client.query<{
        id: string;
        agent_version: string | null;
      }>(
        'SELECT id, agent_version FROM env_provisioning.onprem_machines WHERE token_sha256=$1 AND revoked_at IS NULL FOR UPDATE',
        [hash],
      );
      machineId = found.rows[0]?.id ?? null;
      agentVersion = found.rows[0]?.agent_version ?? null;
      if (!machineId)
        throw new UnauthorizedException(
          'Machine credential is invalid or revoked.',
        );
    }
    const bindings = await client.query<AssignmentRow>(
      `SELECT *, tunnel_reported_at > NOW() - INTERVAL '${TUNNEL_REPORT_WINDOW}' AS tunnel_fresh FROM env_provisioning.onprem_hosts WHERE revoked_at IS NULL AND ${kind === 'machine' ? 'machine_id=$1' : 'token_sha256=$1'} ORDER BY id FOR UPDATE`,
      [machineId ?? hash],
    );
    if (kind === 'legacy' && !bindings.rowCount)
      throw new UnauthorizedException('Host credential is invalid or revoked.');
    return {
      kind,
      machineId,
      /** What the machine reported in its last heartbeat; null for a legacy host. */
      agentVersion,
      assignmentIds: bindings.rows.map((row) => row.id),
      bindings: bindings.rows.map((row) => ({
        ...machineBinding(row),
        /** A running tunnel with a fresh address: production may be handed out. */
        tunnelReady: tunnelReady({
          status: row.tunnel_status,
          url: row.tunnel_url,
          message: row.tunnel_message,
          reportedAt: row.tunnel_reported_at,
          fresh: row.tunnel_fresh === true,
        }),
      })),
    };
  }
  /** Every active binding on a machine, for deriving service links. */
  async machineBindings(machineId: string): Promise<MachineBinding[]> {
    const result = await this.db.query<AssignmentRow>(
      `SELECT *, tunnel_reported_at > NOW() - INTERVAL '${TUNNEL_REPORT_WINDOW}' AS tunnel_fresh FROM env_provisioning.onprem_hosts WHERE machine_id=$1 AND revoked_at IS NULL ORDER BY id`,
      [machineId],
    );
    return result.rows.map(machineBinding);
  }
}

/** A binding on a machine, with the address users reach it at when known. */
export interface MachineBinding {
  id: string;
  projectId: string;
  environmentId: string;
  machine: MachineAssignment | null;
  publicAddress: string | null;
}

function machineBinding(row: AssignmentRow): MachineBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    machine: row.machine_id ? assignment(row) : null,
    publicAddress: row.machine_id
      ? effectivePublicAddress(
          row.assignment_config.ingress,
          tunnelReport({
            status: row.tunnel_status,
            url: row.tunnel_url,
            message: row.tunnel_message,
            reportedAt: row.tunnel_reported_at,
            fresh: row.tunnel_fresh === true,
          }),
        )
      : null,
  };
}
