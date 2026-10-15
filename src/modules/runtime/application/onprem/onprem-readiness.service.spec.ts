import { ConfigService } from '@nestjs/config';
import type { DatabaseService } from '#kernel/db/database.service';
import type { DeploymentProjectReferenceLookup } from '#kernel/ports/deployment-runtime.port';
import { OnpremReadinessService } from './onprem-readiness.service';

describe('On-prem readiness', () => {
  const query = jest.fn();
  const projects = {
    findProjectReference: jest.fn(),
    findProjectEnvironment: jest.fn(),
  };
  const config = new ConfigService({
    PLATFORM_PUBLIC_URL: 'https://api.example.com',
    ONPREM_RELEASES_ENABLED: 'true',
  });
  const service = () =>
    new OnpremReadinessService(
      { query } as unknown as DatabaseService,
      projects as unknown as DeploymentProjectReferenceLookup,
      config,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    projects.findProjectReference.mockResolvedValue({ projectId: 'project' });
    projects.findProjectEnvironment.mockResolvedValue({ id: 'env' });
    query.mockResolvedValue({
      rows: [{ releases: 'releases', hosts: 'hosts', active_host_index: null }],
    });
  });
  it('checks actual schema without DDL and keeps credentials/registry unverified', async () => {
    const result = await service().read('project', 'env', 'viewer');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'schema', status: 'failed' }),
        expect.objectContaining({
          id: 'ci-signing-secret',
          status: 'unverified',
        }),
        expect.objectContaining({ id: 'registry', status: 'unverified' }),
      ]),
    );
    expect(
      query.mock.calls.every(([sql]: [string]) => /^\s*SELECT/.test(sql)),
    ).toBe(true);
  });
  it('checks visibility before inspecting schema', async () => {
    projects.findProjectReference.mockResolvedValue(null);
    await expect(
      service().read('project', 'env', 'other'),
    ).rejects.toMatchObject({ status: 404 });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { fresh: true, revoked: false, expected: 'passed' },
    { fresh: false, revoked: false, expected: 'failed' },
    { fresh: true, revoked: true, expected: 'failed' },
  ])(
    'keeps application health unverified for machine $expected (fresh=$fresh, revoked=$revoked)',
    async ({ fresh, revoked, expected }) => {
      projects.findProjectEnvironment.mockResolvedValue({
        id: 'env',
        role: 'production',
      });
      query
        .mockResolvedValueOnce({
          rows: [
            {
              releases: 'releases',
              hosts: 'hosts',
              active_host_index: true,
              machine_schema: true,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              machine_id: 'machine',
              fresh,
              revoked,
              checks: [
                {
                  id: 'docker',
                  status: 'passed',
                  message: 'Docker and Compose available.',
                },
              ],
              assignment_config: {
                ports: [
                  { slot: 'frontend', hostPort: 8080, containerPort: 3000 },
                ],
                health: [{ slot: 'frontend', path: null }],
                ingress: { mode: 'direct', publicUrl: null },
              },
            },
          ],
        });
      const result = await service().read('project', 'env', 'viewer');
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'host', status: expected }),
          expect.objectContaining({ id: 'health-paths', status: 'failed' }),
          expect.objectContaining({ id: 'ingress', status: 'failed' }),
          expect.objectContaining({
            id: 'application-health',
            status: 'unverified',
          }),
        ]),
      );
    },
  );
});
