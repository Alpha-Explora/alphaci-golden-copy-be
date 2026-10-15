import { BadRequestException } from '@nestjs/common';
import type { AssignmentConfig } from '#kernel/ports/onprem-assignment.port';
import {
  OnpremAssignmentsService,
  defaultAssignmentConfig,
  validateAssignmentConfig,
} from './onprem-assignments.service';
const config: AssignmentConfig = {
  ports: [{ slot: 'frontend', hostPort: 8080, containerPort: 3000 }],
  health: [{ slot: 'frontend', path: '/' }],
  ingress: { mode: 'direct', publicUrl: null },
};
it('supports only the slots actually deployed', () => {
  expect(() =>
    validateAssignmentConfig(config, ['frontend'], false),
  ).not.toThrow();
  expect(() =>
    validateAssignmentConfig(config, ['frontend', 'backend'], false),
  ).toThrow(BadRequestException);
});
it.each([
  '//other.example',
  '/../secret',
  '/%2e%2e/foo',
  'http://localhost:4000',
  '/\\admin',
])('rejects escaping health path %s', (path) => {
  expect(() =>
    validateAssignmentConfig(
      { ...config, health: [{ slot: 'frontend', path }] },
      ['frontend'],
      false,
    ),
  ).toThrow(BadRequestException);
});
it('requires explicit production HTTPS ingress', () => {
  expect(() => validateAssignmentConfig(config, ['frontend'], true)).toThrow(
    BadRequestException,
  );
  expect(() =>
    validateAssignmentConfig(
      {
        ...config,
        ingress: { mode: 'configured', publicUrl: 'https://app.example.com' },
      },
      ['frontend'],
      true,
    ),
  ).not.toThrow();
});

describe('automatic assignment', () => {
  const repository = {
    current: jest.fn(),
    healthyMachines: jest.fn(),
    assign: jest.fn(),
    machineWorkspace: jest.fn(),
  };
  const targets = { listDeploymentTargets: jest.fn() };
  const projects = {
    findProjectReference: jest.fn().mockResolvedValue({ id: 'project' }),
    findProjectEnvironment: jest.fn(),
  };
  const service = () =>
    new OnpremAssignmentsService(
      repository as never,
      {
        assertProjectRole: jest.fn().mockResolvedValue({ workspaceId: 'ws' }),
      } as never,
      { findAppRole: jest.fn().mockResolvedValue('member') } as never,
      projects as never,
      targets as never,
      { get: () => 'true' } as never,
    );
  beforeEach(() => {
    jest.clearAllMocks();
    repository.current.mockResolvedValue(null);
    repository.healthyMachines.mockResolvedValue(['machine']);
    repository.machineWorkspace.mockResolvedValue('ws');
    repository.assign.mockResolvedValue({ id: 'assignment' });
    projects.findProjectEnvironment.mockResolvedValue({
      role: 'non_production',
    });
    targets.listDeploymentTargets.mockResolvedValue([
      { environmentId: 'env', provider: 'onprem-compose', slot: 'frontend' },
    ]);
  });
  it('assigns to the only healthy machine with server-chosen ports', async () => {
    await expect(
      service().ensureAutomaticAssignment('project', 'env', 'user'),
    ).resolves.toEqual({ assignmentId: 'assignment' });
    expect(repository.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: null,
        workspaceId: 'ws',
        config: defaultAssignmentConfig(['frontend']),
      }),
    );
    expect(
      repository.assign.mock.calls[0][0].config.ports[0],
    ).not.toHaveProperty('hostPort');
  });
  it.each([[[]], [['a', 'b']]])(
    'leaves the choice to a person with %j healthy machines',
    async (machines) => {
      repository.healthyMachines.mockResolvedValue(machines);
      await expect(
        service().ensureAutomaticAssignment('project', 'env', 'user'),
      ).resolves.toBeNull();
      expect(repository.assign).not.toHaveBeenCalled();
    },
  );
  it('skips production, which needs an HTTPS ingress, and managed environments', async () => {
    projects.findProjectEnvironment.mockResolvedValue({ role: 'production' });
    await expect(
      service().ensureAutomaticAssignment('project', 'env', 'user'),
    ).resolves.toBeNull();
    projects.findProjectEnvironment.mockResolvedValue({
      role: 'non_production',
    });
    targets.listDeploymentTargets.mockResolvedValue([
      { environmentId: 'env', provider: 'vercel', slot: 'frontend' },
    ]);
    await expect(
      service().ensureAutomaticAssignment('project', 'env', 'user'),
    ).resolves.toBeNull();
    expect(repository.assign).not.toHaveBeenCalled();
  });
  it('reassigns on the same machine when a slot is added, keeping existing settings', async () => {
    repository.current.mockResolvedValue({
      id: 'old',
      machineId: 'machine',
      config: {
        ports: [{ slot: 'frontend', hostPort: 8081, containerPort: 8000 }],
        health: [{ slot: 'frontend', path: '/ready' }],
        ingress: { mode: 'direct', publicUrl: null },
      },
    });
    targets.listDeploymentTargets.mockResolvedValue([
      { environmentId: 'env', provider: 'onprem-compose', slot: 'frontend' },
      { environmentId: 'env', provider: 'onprem-compose', slot: 'backend' },
    ]);
    await service().ensureAutomaticAssignment('project', 'env', 'user');
    expect(repository.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'machine',
        expectedAssignmentId: 'old',
        config: {
          ports: [
            { slot: 'frontend', containerPort: 8000 },
            { slot: 'backend', containerPort: 4000 },
          ],
          health: [
            { slot: 'frontend', path: '/ready' },
            { slot: 'backend', path: '/' },
          ],
          ingress: { mode: 'direct', publicUrl: null },
        },
      }),
    );
  });
  it('never throws when assignment fails', async () => {
    repository.assign.mockRejectedValue(new Error('conflict'));
    await expect(
      service().ensureAutomaticAssignment('project', 'env', 'user'),
    ).resolves.toBeNull();
  });
});
