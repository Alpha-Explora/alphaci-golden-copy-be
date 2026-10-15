import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { WorkspaceAccessPort } from '#kernel/ports/workspaces.port';
import type { AppRoleLookup } from '#kernel/ports/app-role.port';
import type { OnpremMachinesRepository } from '../../infrastructure/repositories/onprem-machines.repository';
import { machineSummary } from '../../infrastructure/repositories/onprem-machines.repository';
import type { OnpremInstallerReleasePort } from '../ports/onprem-installer-release.port';
import { OnpremHostsService } from './onprem-hosts.service';

const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
const explicitInstaller = {
  ONPREM_INSTALLER_URL: 'https://example.com/installer.tgz',
  ONPREM_INSTALLER_SHA256: 'a'.repeat(64),
};
const releaseRepo = { ONPREM_INSTALLER_RELEASE_REPO: 'Alpha-Explora/alphaci' };
const resolvedInstaller = {
  version: '0.1.0',
  url: 'https://github.com/Alpha-Explora/alphaci/releases/download/onprem-agent-v0.1.0/alphaci-agent-0.1.0.tar.gz',
  sha256: 'b'.repeat(64),
};
afterEach(() => jest.restoreAllMocks());
function fixture(installer: Record<string, string> = explicitInstaller) {
  const repository = {
    createEnrollment: jest
      .fn()
      .mockResolvedValue({ id: 'enrollment', expiresAt: 'later' }),
    list: jest.fn(),
    revoke: jest.fn(),
    consume: jest.fn(),
    heartbeat: jest.fn(),
  };
  const access = {
    assertWorkspaceRole: jest.fn().mockResolvedValue({ role: 'member' }),
  };
  const roles = { findAppRole: jest.fn().mockResolvedValue('admin') };
  const installerReleases = {
    resolve: jest.fn().mockResolvedValue(undefined),
  };
  const service = new OnpremHostsService(
    repository as unknown as OnpremMachinesRepository,
    access as unknown as WorkspaceAccessPort,
    roles as unknown as AppRoleLookup,
    new ConfigService({
      ONPREM_RELEASES_ENABLED: 'true',
      ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({ test: publicKey }),
      PLATFORM_PUBLIC_URL: 'https://api.example.com',
      ...installer,
    }),
    installerReleases as unknown as OnpremInstallerReleasePort,
  );
  return { service, repository, access, roles, installerReleases };
}
const enrollmentInput = {
  name: 'host',
  platform: 'ubuntu' as const,
  requestId: 'request',
};
it('uses 256-bit one-time code and passes only its hash to storage', async () => {
  const { service, repository } = fixture();
  const receipt = await service.createEnrollment('workspace', 'user', {
    name: 'host',
    platform: 'ubuntu',
    requestId: 'request',
  });
  expect(Buffer.from(receipt.code, 'base64url')).toHaveLength(32);
  expect(repository.createEnrollment.mock.calls[0][3]).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(JSON.stringify(repository.createEnrollment.mock.calls)).not.toContain(
    receipt.code,
  );
});
it('denies viewer and other-workspace management before generating a code', async () => {
  const { service, access, repository } = fixture();
  access.assertWorkspaceRole.mockRejectedValue(new ForbiddenException());
  await expect(
    service.createEnrollment('workspace', 'viewer', {
      name: 'host',
      platform: 'ubuntu',
      requestId: 'request',
    }),
  ).rejects.toThrow(ForbiddenException);
  expect(access.assertWorkspaceRole).toHaveBeenCalledWith(
    'workspace',
    'viewer',
    ['admin', 'delegated_lead', 'member'],
  );
  expect(repository.createEnrollment).not.toHaveBeenCalled();
});
it('denies a non-hosting application role even with workspace membership', async () => {
  const { service, roles, repository } = fixture();
  roles.findAppRole.mockResolvedValue('qa');
  await expect(service.revoke('workspace', 'machine', 'user')).rejects.toThrow(
    ForbiddenException,
  );
  expect(repository.revoke).not.toHaveBeenCalled();
});
it('reports offline from server freshness and never infers application health', () => {
  const input = {
    id: 'm',
    workspace_id: 'w',
    name: 'machine',
    platform: 'ubuntu' as const,
    agent_version: '1',
    last_seen_at: new Date(),
    revoked_at: null,
    checks: [],
    fresh: false,
  };
  expect(machineSummary(input).status).toBe('offline');
  expect(machineSummary({ ...input, fresh: true }).status).toBe('connected');
  expect(
    machineSummary({ ...input, fresh: true, revoked_at: new Date() }).status,
  ).toBe('revoked');
});
describe('installer release resolution', () => {
  it('uses the explicit URL and hash without consulting the release repository', async () => {
    const { service, installerReleases } = fixture({
      ...explicitInstaller,
      ...releaseRepo,
    });
    const receipt = await service.createEnrollment(
      'workspace',
      'user',
      enrollmentInput,
    );
    expect(installerReleases.resolve).not.toHaveBeenCalled();
    expect(receipt.installer).toEqual({
      version: '0.1.0',
      url: explicitInstaller.ONPREM_INSTALLER_URL,
      sha256: explicitInstaller.ONPREM_INSTALLER_SHA256,
    });
  });
  it('issues a code with the verified release archive when no explicit installer is set', async () => {
    const { service, repository, installerReleases } = fixture(releaseRepo);
    installerReleases.resolve.mockResolvedValue(resolvedInstaller);
    const receipt = await service.createEnrollment(
      'workspace',
      'user',
      enrollmentInput,
    );
    expect(installerReleases.resolve).toHaveBeenCalledWith(
      'Alpha-Explora/alphaci',
      '0.1.0',
    );
    expect(receipt.installer).toEqual(resolvedInstaller);
    expect(repository.createEnrollment).toHaveBeenCalledTimes(1);
  });
  it('refuses to issue a code when the release cannot be verified', async () => {
    const { service, repository, installerReleases } = fixture(releaseRepo);
    installerReleases.resolve.mockResolvedValue(undefined);
    await expect(
      service.createEnrollment('workspace', 'user', enrollmentInput),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(repository.createEnrollment).not.toHaveBeenCalled();
  });
  it('does not fall back to the release repository when the explicit installer is partial', async () => {
    const { service, repository, installerReleases } = fixture({
      ONPREM_INSTALLER_URL: explicitInstaller.ONPREM_INSTALLER_URL,
      ...releaseRepo,
    });
    await expect(
      service.createEnrollment('workspace', 'user', enrollmentInput),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(installerReleases.resolve).not.toHaveBeenCalled();
    expect(repository.createEnrollment).not.toHaveBeenCalled();
  });
  it('refuses to issue a code when no installer is configured', async () => {
    const { service, repository, installerReleases } = fixture({});
    await expect(
      service.createEnrollment('workspace', 'user', enrollmentInput),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(installerReleases.resolve).not.toHaveBeenCalled();
    expect(repository.createEnrollment).not.toHaveBeenCalled();
  });
});
