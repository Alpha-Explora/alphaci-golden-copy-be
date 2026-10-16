import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WORKSPACE_ACCESS_PORT,
  type WorkspaceAccessPort,
} from '#kernel/ports/workspaces.port';
import {
  APP_ROLE_LOOKUP,
  type AppRoleLookup,
} from '#kernel/ports/app-role.port';
import { canManageHosting } from '#kernel/rules/persona-access.rules';
import { OnpremMachinesRepository } from '../../infrastructure/repositories/onprem-machines.repository';
import {
  ONPREM_INSTALLER_RELEASE,
  type OnpremInstallerReleasePort,
} from '../ports/onprem-installer-release.port';
import type {
  EnrollmentInput,
  EnrollmentReceipt,
  EnrollmentResult,
  InstallerRelease,
  MachineCheckIn,
} from './onprem-host.contracts';

export const MACHINE_TOKEN_PREFIX = 'onprem_machine_';
export const hashMachineSecret = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class OnpremHostsService {
  constructor(
    private readonly machines: OnpremMachinesRepository,
    @Inject(WORKSPACE_ACCESS_PORT) private readonly access: WorkspaceAccessPort,
    @Inject(APP_ROLE_LOOKUP) private readonly roles: AppRoleLookup,
    private readonly config: ConfigService,
    @Inject(ONPREM_INSTALLER_RELEASE)
    private readonly installerReleases: OnpremInstallerReleasePort,
  ) {}
  async list(workspaceId: string, userId: string) {
    this.enabled();
    await this.access.assertWorkspaceRole(workspaceId, userId, [
      'admin',
      'delegated_lead',
      'member',
      'viewer',
    ]);
    return this.machines.list(workspaceId);
  }
  async createEnrollment(
    workspaceId: string,
    userId: string,
    input: EnrollmentInput,
  ): Promise<EnrollmentReceipt> {
    this.enabled();
    await this.assertManager(workspaceId, userId);
    this.trustKeys(); // Fail before producing a code that cannot configure a verifier.
    const apiUrl = this.publicApiUrl();
    const installer = await this.installerRelease();
    const name = input.name.trim();
    if (!name || name.length > 80)
      throw new BadRequestException(
        'Host name must contain 1 to 80 characters.',
      );
    const code = randomBytes(32).toString('base64url');
    const receipt = await this.machines.createEnrollment(
      workspaceId,
      userId,
      { ...input, name },
      hashMachineSecret(code),
    );
    return {
      ...receipt,
      apiUrl,
      code,
      // The installer must be told to retire the credential already on disk.
      replacesMachineId: input.replacesMachineId ?? null,
      installer,
    };
  }
  async consumeEnrollment(
    code: string,
    input: MachineCheckIn,
  ): Promise<EnrollmentResult> {
    this.enabled();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code))
      throw new UnauthorizedException('Enrollment code is invalid.');
    const trustKeys = this.trustKeys();
    const apiUrl = this.publicApiUrl();
    const credential =
      MACHINE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const machine = await this.machines.consume(
      hashMachineSecret(code),
      hashMachineSecret(credential),
      credential.slice(0, 22),
      input,
    );
    return {
      machine,
      credential,
      apiUrl: apiUrl.replace(/\/$/, ''),
      trustKeys,
    };
  }
  /** The supervisor forwards and opens exactly the returned host ports. */
  async heartbeat(
    credential: string,
    input: MachineCheckIn,
  ): Promise<{ ports: number[] }> {
    this.enabled();
    if (!credential.startsWith(MACHINE_TOKEN_PREFIX))
      throw new UnauthorizedException('Machine credential is invalid.');
    return this.machines.heartbeat(hashMachineSecret(credential), input);
  }
  /** The active machine a credential belongs to; null for any other credential. */
  async machineIdForCredential(
    credential: string | null,
  ): Promise<string | null> {
    if (!credential?.startsWith(MACHINE_TOKEN_PREFIX)) return null;
    return this.machines.activeMachineId(hashMachineSecret(credential));
  }
  async revoke(
    workspaceId: string,
    machineId: string,
    userId: string,
    replacementMachineId: string | null = null,
  ): Promise<{ moved: number }> {
    this.enabled();
    await this.assertManager(workspaceId, userId);
    return this.machines.revoke(workspaceId, machineId, replacementMachineId);
  }
  private async assertManager(workspaceId: string, userId: string) {
    await this.access.assertWorkspaceRole(workspaceId, userId, [
      'admin',
      'delegated_lead',
      'member',
    ]);
    if (!canManageHosting(await this.roles.findAppRole(userId)))
      throw new ForbiddenException(
        'Your application role cannot manage hosting.',
      );
  }
  private enabled() {
    if (this.config.get('ONPREM_RELEASES_ENABLED') !== 'true')
      throw new ForbiddenException('On-prem delivery is disabled.');
  }
  /**
   * A complete explicit URL and SHA-256 win. Without an explicit URL,
   * ONPREM_INSTALLER_RELEASE_REPO supplies the archive, and a configured
   * SHA-256 pins its hash. Every other case refuses, so no enrollment code is
   * issued for an installer that is not verified.
   */
  private async installerRelease(): Promise<InstallerRelease> {
    const version =
      this.config.get<string>('ONPREM_INSTALLER_VERSION') || '0.2.0';
    const url = this.config.get<string>('ONPREM_INSTALLER_URL') || '';
    const sha256 = this.config.get<string>('ONPREM_INSTALLER_SHA256') || '';
    const releaseRepo =
      this.config.get<string>('ONPREM_INSTALLER_RELEASE_REPO') || '';
    const token =
      this.config.get<string>('ONPREM_INSTALLER_RELEASE_TOKEN') || undefined;
    if (url && sha256) {
      if (/^https:\/\//.test(url) && /^[0-9a-f]{64}$/.test(sha256))
        return { version, url, sha256 };
    } else if (
      !url &&
      releaseRepo &&
      (!sha256 || /^[0-9a-f]{64}$/.test(sha256))
    ) {
      const release = await this.installerReleases.resolve({
        repo: releaseRepo,
        version,
        pinnedSha256: sha256 || undefined,
        token,
      });
      if (release) return release;
    }
    throw new ServiceUnavailableException(
      'Publish or configure a verified installer release before enrolling a host.',
    );
  }
  private publicApiUrl(): string {
    try {
      const url = new URL(
        this.config.get<string>('PLATFORM_PUBLIC_URL') ||
          this.config.get<string>('API_PUBLIC_URL') ||
          '',
      );
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      return url.toString().replace(/\/$/, '');
    } catch {
      throw new ServiceUnavailableException(
        'Configure the public HTTPS API address first.',
      );
    }
  }
  private trustKeys(): Record<string, string> {
    try {
      const keys: unknown = JSON.parse(
        this.config.get<string>('ALPHACI_RELEASE_TRUST_KEYS_JSON') || '{}',
      );
      if (
        !keys ||
        typeof keys !== 'object' ||
        Array.isArray(keys) ||
        !Object.keys(keys).length
      )
        throw new Error();
      for (const [id, pem] of Object.entries(keys)) {
        if (
          !id ||
          typeof pem !== 'string' ||
          !pem.startsWith('-----BEGIN PUBLIC KEY-----')
        )
          throw new Error();
        const key = createPublicKey(pem);
        if (
          key.asymmetricKeyType !== 'ec' ||
          key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        )
          throw new Error();
      }
      return keys as Record<string, string>;
    } catch {
      throw new ServiceUnavailableException(
        'Configure P-256 public release trust keys before enrollment.',
      );
    }
  }
}
