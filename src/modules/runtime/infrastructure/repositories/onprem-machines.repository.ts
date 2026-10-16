import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '#kernel/db/database.service';
import {
  endMachineBindings,
  moveMachineBindings,
} from './onprem-assignments.repository';
import type {
  EnrollmentInput,
  MachineCheckIn,
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

  /** Records a check-in and returns the host ports reserved on the machine. */
  async heartbeat(
    hash: string,
    input: MachineCheckIn,
  ): Promise<{ ports: number[] }> {
    return this.db.withTransaction(async (client) => {
      const machine = await client.query<{ id: string }>(
        `SELECT id FROM env_provisioning.onprem_machines WHERE token_sha256=$1 AND revoked_at IS NULL FOR UPDATE`,
        [hash],
      );
      if (!machine.rows[0])
        throw new UnauthorizedException(
          'Machine credential is invalid or revoked.',
        );
      await client.query(
        `UPDATE env_provisioning.onprem_machines SET last_seen_at=NOW(),agent_version=$2,checks=$3 WHERE id=$1`,
        [machine.rows[0].id, input.agentVersion, JSON.stringify(input.checks)],
      );
      const ports = await client.query<{ host_port: number }>(
        `SELECT host_port FROM env_provisioning.onprem_port_reservations WHERE machine_id=$1 ORDER BY host_port`,
        [machine.rows[0].id],
      );
      return { ports: ports.rows.map((port) => port.host_port) };
    });
  }

  /**
   * Retire a machine. With a replacement, its active environments move there
   * first, keeping host ports where they are free on the replacement. Without
   * one, its bindings end, so the environments are free to assign again.
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
      } else {
        await endMachineBindings(client, id);
      }
      await client.query(
        `UPDATE env_provisioning.onprem_machines SET revoked_at=COALESCE(revoked_at,NOW()) WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id],
      );
      return { moved };
    });
  }

  /** The active machine holding this credential hash; null when unknown or revoked. */
  async activeMachineId(hash: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM env_provisioning.onprem_machines WHERE token_sha256=$1 AND revoked_at IS NULL`,
      [hash],
    );
    return result.rows[0]?.id ?? null;
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
      // Machines first, then their bindings: the same lock order as assignment.
      const result = await client.query(
        `UPDATE env_provisioning.onprem_machines SET revoked_at=NOW() WHERE workspace_id=$1 AND revoked_at IS NULL`,
        [workspaceId],
      );
      await client.query(
        `UPDATE env_provisioning.onprem_hosts SET revoked_at=NOW() WHERE revoked_at IS NULL AND machine_id IN (SELECT id FROM env_provisioning.onprem_machines WHERE workspace_id=$1)`,
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
