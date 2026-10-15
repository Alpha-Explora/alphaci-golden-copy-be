import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import type { WorkspaceAccessPort } from '#kernel/ports/workspaces.port';
import type { AppRoleLookup } from '#kernel/ports/app-role.port';
import type { OnpremMachinesRepository } from '../../infrastructure/repositories/onprem-machines.repository';
import { machineSummary } from '../../infrastructure/repositories/onprem-machines.repository';
import { OnpremHostsService } from './onprem-hosts.service';

const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
function fixture() {
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
  const service = new OnpremHostsService(
    repository as unknown as OnpremMachinesRepository,
    access as unknown as WorkspaceAccessPort,
    roles as unknown as AppRoleLookup,
    new ConfigService({
      ONPREM_RELEASES_ENABLED: 'true',
      ALPHACI_RELEASE_TRUST_KEYS_JSON: JSON.stringify({ test: publicKey }),
      ONPREM_INSTALLER_URL: 'https://example.com/installer.tgz',
      ONPREM_INSTALLER_SHA256: 'a'.repeat(64),
      PLATFORM_PUBLIC_URL: 'https://api.example.com',
    }),
  );
  return { service, repository, access, roles };
}
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
