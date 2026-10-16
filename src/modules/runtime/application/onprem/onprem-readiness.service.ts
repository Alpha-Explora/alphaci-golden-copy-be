import { createPublicKey } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '#kernel/db/database.service';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  type DeploymentProjectReferenceLookup,
} from '#kernel/ports/deployment-runtime.port';
import { validateCiApiConnectivity } from '#kernel/config/ci-api-connectivity';
import {
  RELEASE_TRUST_KEYS_ENV,
  resolveReleaseSigningSource,
} from '#kernel/config/release-signing.config';
import {
  kmsTrustProblem,
  labTrustProblem,
  readLabSigningKey,
} from '#kernel/config/release-signing-key';
import type { AssignmentConfig } from '#kernel/ports/onprem-assignment.port';

export interface ReadinessCheck {
  id: string;
  status: 'passed' | 'failed' | 'unverified';
  message: string;
}
export interface OnpremReadiness {
  checks: ReadinessCheck[];
}

@Injectable()
export class OnpremReadinessService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(DEPLOYMENT_PROJECT_REFERENCE_LOOKUP)
    private readonly projects: DeploymentProjectReferenceLookup,
    private readonly config: ConfigService,
  ) {}

  async read(
    projectId: string,
    environmentId: string,
    userId: string,
  ): Promise<OnpremReadiness> {
    if (!(await this.projects.findProjectReference(projectId, userId)))
      throw new NotFoundException('Project not found');
    const environment = await this.projects.findProjectEnvironment(
      projectId,
      environmentId,
    );
    if (!environment) throw new NotFoundException('Environment not found');
    const checks: ReadinessCheck[] = [];
    const check = (
      id: string,
      status: ReadinessCheck['status'],
      message: string,
    ) => checks.push({ id, status, message });
    check(
      'enabled',
      this.config.get('ONPREM_RELEASES_ENABLED') === 'true'
        ? 'passed'
        : 'failed',
      'On-prem release delivery configuration.',
    );
    try {
      const result = await this.database.query<{
        releases: string | null;
        hosts: string | null;
        active_host_index: boolean;
        machine_schema: boolean;
      }>(
        `SELECT to_regclass('env_provisioning.releases') AS releases,
                to_regclass('env_provisioning.onprem_hosts') AS hosts,
                EXISTS (SELECT 1 FROM pg_index
                         WHERE indexrelid = to_regclass('env_provisioning.onprem_hosts_one_active_per_environment')
                           AND indisvalid AND indisunique) AS active_host_index,
                (to_regclass('env_provisioning.onprem_machines') IS NOT NULL
                 AND to_regclass('env_provisioning.onprem_enrollments') IS NOT NULL
                 AND to_regclass('env_provisioning.onprem_workspace_lifecycle') IS NOT NULL
                 AND to_regclass('env_provisioning.onprem_port_reservations') IS NOT NULL
                 AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('env_provisioning.onprem_hosts') AND attname='machine_id' AND NOT attisdropped)) AS machine_schema`,
      );
      const schema = result.rows[0];
      const missing = [
        !schema?.releases && '20260928200000_release_registry.sql: releases',
        !schema?.hosts && '20260928200000_release_registry.sql: onprem_hosts',
        !schema?.active_host_index &&
          '20261015010000_one_active_onprem_host.sql: onprem_hosts_one_active_per_environment',
        !schema?.machine_schema &&
          '20261015020000_onprem_machines.sql and 20261015030000_onprem_machine_assignments.sql',
      ].filter(Boolean);
      check(
        'schema',
        missing.length ? 'failed' : 'passed',
        missing.length
          ? 'Missing schema objects: ' + missing.join(', ')
          : 'Required release and host schema objects exist.',
      );
      if (schema?.machine_schema) {
        await this.machineChecks(
          projectId,
          environmentId,
          environment.role === 'production',
          check,
        );
      } else if (schema?.hosts) {
        const hosts = await this.database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM env_provisioning.onprem_hosts WHERE project_id = $1 AND environment_id = $2 AND revoked_at IS NULL`,
          [projectId, environmentId],
        );
        check(
          'host',
          Number(hosts.rows[0]?.count ?? 0) > 0 ? 'unverified' : 'failed',
          Number(hosts.rows[0]?.count ?? 0) > 0
            ? 'Host assigned; heartbeat and application health require separate evidence.'
            : 'No host assigned.',
        );
      }
    } catch {
      check(
        'schema',
        'unverified',
        'Schema could not be inspected. Check database connectivity.',
      );
    }
    try {
      validateCiApiConnectivity(
        this.config.get<string>('PLATFORM_PUBLIC_URL') ||
          this.config.get<string>('API_PUBLIC_URL') ||
          '',
        'github-hosted',
      );
      check('ci-api-url', 'passed', 'Public HTTPS API address configured.');
    } catch {
      check(
        'ci-api-url',
        'failed',
        'Set PLATFORM_PUBLIC_URL to an HTTPS address reachable from GitHub-hosted runners.',
      );
    }
    check(
      'ci-api-reachability',
      'unverified',
      'Verify authorization and result reporting from an actual GitHub runner.',
    );
    try {
      const keys: unknown = JSON.parse(
        this.config.get<string>('ALPHACI_RELEASE_TRUST_KEYS_JSON') || '{}',
      );
      if (
        !keys ||
        typeof keys !== 'object' ||
        Array.isArray(keys) ||
        Object.keys(keys).length === 0
      )
        throw new Error();
      for (const pem of Object.values(keys)) {
        if (typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY'))
          throw new Error();
        const key = createPublicKey(pem);
        if (
          key.asymmetricKeyType !== 'ec' ||
          key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        )
          throw new Error();
      }
      check(
        'signing-trust',
        'passed',
        'Release verification public keys configured.',
      );
    } catch {
      check(
        'signing-trust',
        'failed',
        'Configure valid P-256 release verification public keys.',
      );
    }
    const signing = await this.releaseSigningStatus();
    check('release-signing', signing.status, signing.message);
    check(
      'ci-signing-secret',
      'unverified',
      'CI signing secret access and a matching signature must be verified by the signing workflow.',
    );
    check(
      'registry',
      'unverified',
      'Verify image pull access from the assigned host.',
    );
    return { checks };
  }

  /**
   * Whether releases can be signed and verified: a usable signing source, and a
   * trust entry that verifies its key ID. Cloud KMS is the production path; the
   * lab key is accepted only as a lab-only source.
   */
  private async releaseSigningStatus(): Promise<{
    status: ReadinessCheck['status'];
    message: string;
  }> {
    const read = (key: string) => this.config.get<string>(key);
    const source = resolveReleaseSigningSource(read);
    const trustKeys = read(RELEASE_TRUST_KEYS_ENV);
    const failed = (message: string) => ({
      status: 'failed' as const,
      message,
    });
    switch (source.kind) {
      case 'none':
        return failed(
          'Releases cannot be signed: configure Cloud KMS (ALPHACI_RELEASE_KMS_KEY_VERSION with its two signer settings). Lab hosts only may use ONPREM_LAB_SIGNING_KEY_PATH.',
        );
      case 'invalid':
        return failed(`Releases cannot be signed: ${source.problem}`);
      case 'kms': {
        const problem = kmsTrustProblem(source.keyVersion, trustKeys);
        return problem
          ? failed(problem)
          : {
              status: 'passed',
              message:
                'Releases are signed with Cloud KMS, and the key version is trusted.',
            };
      }
      case 'lab': {
        let pem: string;
        try {
          pem = await readLabSigningKey(source.keyPath);
        } catch (error) {
          return failed(
            `The lab signing key cannot be used: ${error instanceof Error ? error.message : 'unreadable'}.`,
          );
        }
        const problem = labTrustProblem(pem, trustKeys);
        return problem
          ? failed(problem)
          : {
              status: 'passed',
              message:
                'Releases are signed with a lab key (ONPREM_LAB_SIGNING_KEY_PATH) that is trusted. Lab hosts only; client hosts must use Cloud KMS.',
            };
      }
    }
  }

  private async machineChecks(
    projectId: string,
    environmentId: string,
    production: boolean,
    check: (
      id: string,
      status: ReadinessCheck['status'],
      message: string,
    ) => void,
  ) {
    const result = await this.database.query<{
      machine_id: string | null;
      revoked: boolean;
      fresh: boolean;
      checks: ReadinessCheck[];
      assignment_config: AssignmentConfig | null;
    }>(
      `SELECT h.machine_id, m.revoked_at IS NOT NULL AS revoked,
                m.last_seen_at > NOW()-INTERVAL '90 seconds' AS fresh,
                m.checks, h.assignment_config
           FROM env_provisioning.onprem_hosts h
           LEFT JOIN env_provisioning.onprem_machines m ON m.id=h.machine_id
          WHERE h.project_id=$1 AND h.environment_id=$2 AND h.revoked_at IS NULL`,
      [projectId, environmentId],
    );
    const host = result.rows[0];
    if (!host?.machine_id) {
      check(
        'host',
        host ? 'unverified' : 'failed',
        host
          ? 'Legacy host assigned. Its heartbeat is unavailable.'
          : 'No host assigned.',
      );
      return;
    }
    check(
      'host',
      !host.revoked && host.fresh ? 'passed' : 'failed',
      host.revoked
        ? 'Machine access was revoked. Replace the assignment.'
        : host.fresh
          ? 'Machine checked in within 90 seconds.'
          : 'Machine is offline. Start its agent and check connectivity.',
    );
    const docker = host.checks?.find((item) => item.id === 'docker');
    check(
      'host-prerequisites',
      docker?.status === 'passed' ? 'passed' : 'failed',
      docker?.message ?? 'No Docker prerequisite report received.',
    );
    const config = host.assignment_config;
    check(
      'health-paths',
      config?.health.length && config.health.every((item) => item.path !== null)
        ? 'passed'
        : 'failed',
      'Every deployed slot needs an explicit health path before the agent can deploy it.',
    );
    check(
      'ingress',
      production &&
        (config?.ingress.mode !== 'configured' ||
          !config.ingress.publicUrl?.startsWith('https://'))
        ? 'failed'
        : 'unverified',
      production
        ? 'Verify the configured HTTPS ingress from a client device.'
        : 'Verify access through the configured host ports from a client device.',
    );
    check(
      'host-ports',
      'unverified',
      'Assignment ports are reserved in AlphaCI. The agent checks actual port availability before starting Compose.',
    );
    check(
      'application-health',
      'unverified',
      'A machine connection does not prove a deployment healthy. Check its signed release and deployment history.',
    );
  }
}
