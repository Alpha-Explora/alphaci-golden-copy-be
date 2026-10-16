import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '#kernel/db/database.service';
import type { AssignmentConfig } from '#kernel/ports/onprem-assignment.port';
import { tunnelPort } from '../../domain/onprem-tunnel';
import { moveMachineBindings } from './onprem-assignments.repository';
import type {
  EnrollmentInput,
  HeartbeatReply,
  MachineCheckIn,
  MachineHeartbeat,
  MachineSummary,
} from '../../application/onprem/onprem-host.contracts';

interface MachineRow {
  id: string;
  workspace_id: string;
  name: string;
  platform: 'windows' | 'ubuntu';
  agent_version: string | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  checks: MachineSummary['checks'];
  fresh: boolean;
}
interface EnrollmentRow {
  id: string;
  workspace_id: string;
  name: string;
  platform: 'windows' | 'ubuntu';
  created_by: string;
  replaces_machine_id: string | null;
  consumed_at: Date | null;
  expired: boolean;
}
export function machineSummary(row: MachineRow): MachineSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    platform: row.platform,
    agentVersion: row.agent_version,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    checks: row.checks,
    status: row.revoked_at
      ? 'revoked'
      : !row.fresh
        ? 'offline'
        : row.checks.some((check) => check.status === 'failed')
          ? 'prerequisites_failed'
          : 'connected',
  };
}
const MACHINE_SELECT = `SELECT *, last_seen_at > NOW() - INTERVAL '90 seconds' AS fresh FROM env_provisioning.onprem_machines`;

@Injectable()
export class OnpremMachinesRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(workspaceId: string): Promise<MachineSummary[]> {
    const machines = await this.db.query<MachineRow>(
      `${MACHINE_SELECT} WHERE workspace_id=$1 ORDER BY created_at`,
      [workspaceId],
    );
    const pending = await this.db.query<{
      id: string;
      name: string;
      platform: 'windows' | 'ubuntu';
    }>(
      `SELECT id, name, platform FROM env_provisioning.onprem_enrollments WHERE workspace_id=$1 AND consumed_at IS NULL AND expires_at > NOW() ORDER BY created_at`,
      [workspaceId],
    );
    return [
      ...machines.rows.map(machineSummary),
      ...pending.rows.map(
        (row): MachineSummary => ({
          id: row.id,
          workspaceId,
          name: row.name,
          platform: row.platform,
          agentVersion: null,
          lastSeenAt: null,
          status: 'enrollment_pending',
          checks: [],
        }),
      ),
    ];
  }

  async createEnrollment(
    workspaceId: string,
    userId: string,
    input: EnrollmentInput,
    codeHash: string,
  ) {
    return this.db.withTransaction(async (client) => {
      await this.lockWorkspace(client, workspaceId);
      if (input.replacesMachineId) {
        const machine = await client.query(
          `SELECT id FROM env_provisioning.onprem_machines WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
          [input.replacesMachineId, workspaceId],
        );
        if (!machine.rowCount)
          throw new ConflictException(
            'Replacement machine does not belong to this workspace.',
          );
      }
      const result = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO env_provisioning.onprem_enrollments(workspace_id, created_by, name, platform, request_id, replaces_machine_id, code_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id, request_id) DO NOTHING RETURNING id, expires_at`,
        [
          workspaceId,
          userId,
          input.name,
          input.platform,
          input.requestId,
          input.replacesMachineId ?? null,
          codeHash,
        ],
      );
      if (!result.rows[0])
        throw new ConflictException(
          'This enrollment request already exists. Use its displayed code or create a new enrollment request; codes cannot be recovered.',
        );
      return {
        id: result.rows[0].id,
        expiresAt: result.rows[0].expires_at.toISOString(),
      };
    });
  }

  async consume(
    codeHash: string,
    tokenHash: string,
    prefix: string,
    input: MachineCheckIn,
  ): Promise<MachineSummary> {
    return this.db.withTransaction(async (client) => {
      // Lock workspace first, consistently with deletion and enrollment creation.
      const lookup = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM env_provisioning.onprem_enrollments WHERE code_sha256=$1`,
        [codeHash],
      );
      if (!lookup.rows[0])
        throw new UnauthorizedException('Enrollment code is invalid.');
      await this.lockWorkspace(client, lookup.rows[0].workspace_id);
      const found = await client.query<EnrollmentRow>(
        `SELECT *, expires_at <= NOW() AS expired FROM env_provisioning.onprem_enrollments WHERE code_sha256=$1 FOR UPDATE`,
        [codeHash],
      );
      const enrollment = found.rows[0];
      if (!enrollment || enrollment.expired || enrollment.consumed_at)
        throw new ConflictException(
          'Enrollment expired or was already consumed. Create a new code; use explicit replacement if a credential was lost.',
        );
      if (enrollment.replaces_machine_id) {
        await client.query(
          `UPDATE env_provisioning.onprem_machines SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1 AND workspace_id=$2`,
          [enrollment.replaces_machine_id, enrollment.workspace_id],
        );
      }
      const created = await client.query<MachineRow>(
        `INSERT INTO env_provisioning.onprem_machines(workspace_id,name,platform,created_by,token_prefix,token_sha256,agent_version,checks,last_seen_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *, true AS fresh`,
        [
          enrollment.workspace_id,
          enrollment.name,
          enrollment.platform,
          enrollment.created_by,
          prefix,
          tokenHash,
          input.agentVersion,
          JSON.stringify(input.checks),
        ],
      );
      const row = created.rows[0]!;
      // The replacement takes over the retired machine's environments.
      if (enrollment.replaces_machine_id)
        await moveMachineBindings(
          client,
          enrollment.replaces_machine_id,
          row.id,
        );
      await client.query(
        `UPDATE env_provisioning.onprem_enrollments SET consumed_at=NOW(),machine_id=$2 WHERE id=$1`,
        [enrollment.id, row.id],
      );
      return machineSummary(row);
    });
  }

  /**
   * Records a check-in. Returns the host ports reserved on the machine and the
   * tunnel-mode assignments it must keep a tunnel open for.
   */
  async heartbeat(
    hash: string,
    input: MachineHeartbeat,
  ): Promise<HeartbeatReply> {
    return this.db.withTransaction(async (client) => {
      const machine = await client.query<{ id: string }>(
        `SELECT id FROM env_provisioning.onprem_machines WHERE token_sha256=$1 AND revoked_at IS NULL FOR UPDATE`,
        [hash],
      );
      if (!machine.rows[0])
        throw new UnauthorizedException(
          'Machine credential is invalid or revoked.',
        );
      const machineId = machine.rows[0].id;
      await client.query(
        `UPDATE env_provisioning.onprem_machines SET last_seen_at=NOW(),agent_version=$2,checks=$3 WHERE id=$1`,
        [machineId, input.agentVersion, JSON.stringify(input.checks)],
      );
      if (input.tunnels) {
        // The reports are a snapshot: a binding the machine stopped reporting
        // loses its address, and each reported tunnel-mode binding takes its own.
        await client.query(
          `UPDATE env_provisioning.onprem_hosts SET tunnel_status=NULL,tunnel_url=NULL,tunnel_message=NULL,tunnel_reported_at=NULL
            WHERE machine_id=$1 AND revoked_at IS NULL AND NOT (id=ANY($2::uuid[]))`,
          [machineId, input.tunnels.map((report) => report.assignmentId)],
        );
        for (const report of input.tunnels)
          await client.query(
            `UPDATE env_provisioning.onprem_hosts SET tunnel_status=$3,tunnel_url=$4,tunnel_message=$5,tunnel_reported_at=NOW()
              WHERE id=$2 AND machine_id=$1 AND revoked_at IS NULL AND assignment_config->'ingress'->>'mode'='tunnel'`,
            [
              machineId,
              report.assignmentId,
              report.status,
              report.publicUrl,
              report.message,
            ],
          );
      }
      const ports = await client.query<{ host_port: number }>(
        `SELECT host_port FROM env_provisioning.onprem_port_reservations WHERE machine_id=$1 ORDER BY host_port`,
        [machineId],
      );
      const tunnels = await client.query<{
        id: string;
        project_id: string;
        environment_id: string;
        assignment_config: AssignmentConfig;
      }>(
        `SELECT id,project_id,environment_id,assignment_config FROM env_provisioning.onprem_hosts
          WHERE machine_id=$1 AND revoked_at IS NULL AND assignment_config->'ingress'->>'mode'='tunnel' ORDER BY id`,
        [machineId],
      );
      return {
        ports: ports.rows.map((port) => port.host_port),
        tunnels: tunnels.rows.flatMap((row) => {
          const hostPort = tunnelPort(row.assignment_config.ports);
          return hostPort === null
            ? []
            : [
                {
                  assignmentId: row.id,
                  projectId: row.project_id,
                  environmentId: row.environment_id,
                  hostPort,
                },
              ];
        }),
      };
    });
  }

  /**
   * Retire a machine. With a replacement, its active environments move there
   * first, keeping host ports where they are free on the replacement.
   */
  async revoke(
    workspaceId: string,
    id: string,
    replacementId: string | null = null,
  ): Promise<{ moved: number }> {
    return this.db.withTransaction(async (client) => {
      if (replacementId === id)
        throw new ConflictException('A machine cannot replace itself.');
      // Lock both machines in a fixed order so concurrent revocations cannot deadlock.
      const locked = await client.query<{
        id: string;
        revoked_at: Date | null;
      }>(
        `SELECT id, revoked_at FROM env_provisioning.onprem_machines WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [workspaceId, replacementId ? [id, replacementId] : [id]],
      );
      if (!locked.rows.some((row) => row.id === id))
        throw new ConflictException(
          'Machine does not belong to this workspace.',
        );
      let moved = 0;
      if (replacementId) {
        const replacement = locked.rows.find((row) => row.id === replacementId);
        if (!replacement || replacement.revoked_at)
          throw new ConflictException(
            'Replacement machine must be an active machine in this workspace.',
          );
        moved = await moveMachineBindings(client, id, replacementId);
      }
      await client.query(
        `UPDATE env_provisioning.onprem_machines SET revoked_at=COALESCE(revoked_at,NOW()) WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id],
      );
      return { moved };
    });
  }

  async purgeWorkspace(workspaceId: string): Promise<{ removed: number }> {
    return this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO env_provisioning.onprem_workspace_lifecycle(workspace_id,deleted_at) VALUES($1,NOW()) ON CONFLICT(workspace_id) DO UPDATE SET deleted_at=NOW()`,
        [workspaceId],
      );
      await client.query(
        `UPDATE env_provisioning.onprem_enrollments SET expires_at=LEAST(expires_at,NOW()) WHERE workspace_id=$1`,
        [workspaceId],
      );
      const result = await client.query(
        `UPDATE env_provisioning.onprem_machines SET revoked_at=NOW() WHERE workspace_id=$1 AND revoked_at IS NULL`,
        [workspaceId],
      );
      return { removed: result.rowCount ?? 0 };
    });
  }

  private async lockWorkspace(client: PoolClient, workspaceId: string) {
    await client.query(
      `INSERT INTO env_provisioning.onprem_workspace_lifecycle(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`,
      [workspaceId],
    );
    const result = await client.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM env_provisioning.onprem_workspace_lifecycle WHERE workspace_id=$1 FOR UPDATE`,
      [workspaceId],
    );
    if (result.rows[0]?.deleted_at)
      throw new ConflictException('Workspace has been deleted.');
  }
}
