import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Request } from 'express';

import {
  ProjectQaChecklistsController,
  QaChecklistsController,
  WorkspaceQaChecklistsController,
} from './qa-checklists.controller';
import { QaChecklistsService } from '../application/qa-checklists/qa-checklists.service';

const fakeUser = { id: 'user-1', login: 'tone' };

const makeRequest = (user: typeof fakeUser | undefined = fakeUser) =>
  ({
    session: { user, userId: user?.id },
  }) as unknown as Request;

const makeUnauthRequest = () => ({ session: {} }) as unknown as Request;

const makeService = () =>
  ({
    listForWorkspace: jest
      .fn()
      .mockResolvedValue({ items: [], canManage: true }),
    createForWorkspace: jest.fn().mockResolvedValue({ id: 'checklist-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'checklist-1' }),
    updateMeta: jest.fn().mockResolvedValue({ id: 'checklist-1' }),
    replaceItems: jest.fn().mockResolvedValue({ id: 'checklist-1' }),
    archive: jest.fn().mockResolvedValue({ id: 'checklist-1' }),
    setSharedProjects: jest.fn().mockResolvedValue({ id: 'checklist-1' }),
    listForProject: jest
      .fn()
      .mockResolvedValue({ items: [], canManage: false }),
  }) as unknown as QaChecklistsService;

async function compileModule(
  controllerClass: new (...args: never[]) => unknown,
  service: QaChecklistsService,
) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [controllerClass],
    providers: [{ provide: QaChecklistsService, useValue: service }],
  })
    .overrideGuard(
      require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
    )
    .useValue({ canActivate: () => true })
    .overrideGuard(require('#kernel/composition/index.js').CapabilityGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return module;
}

describe('WorkspaceQaChecklistsController', () => {
  let controller: WorkspaceQaChecklistsController;
  let service: QaChecklistsService;

  beforeEach(async () => {
    service = makeService();
    const module = await compileModule(
      WorkspaceQaChecklistsController,
      service,
    );
    controller = module.get(WorkspaceQaChecklistsController);
  });

  it('lists checklists for a workspace, parsing includeArchived', async () => {
    await controller.list(makeRequest(), 'workspace-1', 'true');

    expect(service.listForWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'user-1',
      true,
    );
  });

  it('defaults includeArchived to false when omitted', async () => {
    await controller.list(makeRequest(), 'workspace-1', undefined);

    expect(service.listForWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'user-1',
      false,
    );
  });

  it('creates a checklist for the workspace', async () => {
    const body = { name: 'Release checklist' };
    await controller.create(makeRequest(), 'workspace-1', body as never);

    expect(service.createForWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'user-1',
      body,
    );
  });

  it('throws when there is no session user', async () => {
    expect(() => controller.list(makeUnauthRequest(), 'workspace-1')).toThrow(
      UnauthorizedException,
    );
  });
});

describe('QaChecklistsController', () => {
  let controller: QaChecklistsController;
  let service: QaChecklistsService;

  beforeEach(async () => {
    service = makeService();
    const module = await compileModule(QaChecklistsController, service);
    controller = module.get(QaChecklistsController);
  });

  it('gets a checklist by id', async () => {
    await controller.getById(makeRequest(), 'checklist-1');
    expect(service.getById).toHaveBeenCalledWith('checklist-1', 'user-1');
  });

  it('updates checklist metadata', async () => {
    const body = { expectedVersion: 1, name: 'New name' };
    await controller.updateMeta(makeRequest(), 'checklist-1', body as never);
    expect(service.updateMeta).toHaveBeenCalledWith(
      'checklist-1',
      'user-1',
      body,
    );
  });

  it('replaces the item list', async () => {
    const body = { expectedVersion: 1, items: [] };
    await controller.replaceItems(makeRequest(), 'checklist-1', body as never);
    expect(service.replaceItems).toHaveBeenCalledWith(
      'checklist-1',
      'user-1',
      body,
    );
  });

  it('archives a checklist', async () => {
    await controller.archive(makeRequest(), 'checklist-1');
    expect(service.archive).toHaveBeenCalledWith('checklist-1', 'user-1');
  });

  it('replaces the shared project set', async () => {
    const body = { projectIds: ['project-1'] };
    await controller.setSharedProjects(
      makeRequest(),
      'checklist-1',
      body as never,
    );
    expect(service.setSharedProjects).toHaveBeenCalledWith(
      'checklist-1',
      'user-1',
      body,
    );
  });
});

describe('ProjectQaChecklistsController', () => {
  it('lists checklists shared to a project', async () => {
    const service = makeService();
    const module = await compileModule(ProjectQaChecklistsController, service);
    const controller = module.get(ProjectQaChecklistsController);

    await controller.list(makeRequest(), 'project-1');

    expect(service.listForProject).toHaveBeenCalledWith('project-1', 'user-1');
  });
});
