import { createPublicKey } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '#kernel/db/database.service';
import {
  DEPLOYMENT_PROJECT_REFERENCE_LOOKUP,
  type DeploymentProjectReferenceLookup,
} from '#kernel/ports/deployment-runtime.port';
import { validateCiApiConnectivity } from '#kernel/config/ci-api-connectivity';

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
    if (!(await this.projects.findProjectEnvironment(projectId, environmentId)))
      throw new NotFoundException('Environment not found');
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
      }>(
        `SELECT to_regclass('env_provisioning.releases') AS releases,
                to_regclass('env_provisioning.onprem_hosts') AS hosts,
                EXISTS (SELECT 1 FROM pg_index
                         WHERE indexrelid = to_regclass('env_provisioning.onprem_hosts_one_active_per_environment')
                           AND indisvalid AND indisunique) AS active_host_index`,
      );
      const schema = result.rows[0];
      const missing = [
        !schema?.releases && '20260928200000_release_registry.sql: releases',
        !schema?.hosts && '20260928200000_release_registry.sql: onprem_hosts',
        !schema?.active_host_index &&
          '20261015010000_one_active_onprem_host.sql: onprem_hosts_one_active_per_environment',
      ].filter(Boolean);
      check(
        'schema',
        missing.length ? 'failed' : 'passed',
        missing.length
          ? 'Missing schema objects: ' + missing.join(', ')
          : 'Required release and host schema objects exist.',
      );
      if (schema?.hosts) {
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
}
