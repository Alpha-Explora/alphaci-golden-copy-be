import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from '../application/workflows/workflows.service.js';
import type { Request } from 'express';

const fakeUser = { id: 'user-1', login: 'testuser' };

const makeRequest = (
  user: typeof fakeUser | undefined = fakeUser,
  githubToken?: string,
) =>
  ({ session: { user, githubAccessToken: githubToken } }) as unknown as Request;

const makeUnauthRequest = () => ({ session: {} }) as unknown as Request;

const makeWorkflowsService = () =>
  ({
    generate: jest.fn().mockResolvedValue({ yaml: 'name: test', metadata: {} }),
    getHistory: jest.fn().mockResolvedValue([]),
  }) as unknown as WorkflowsService;

describe('WorkflowsController', () => {
  let controller: WorkflowsController;
  let service: WorkflowsService;

  beforeEach(async () => {
    service = makeWorkflowsService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkflowsController],
      providers: [{ provide: WorkflowsService, useValue: service }],
    })
      .overrideGuard(
        require('#kernel/auth/session-auth.guard.js').SessionAuthGuard,
      )
      .useValue({ canActivate: () => true })
      .overrideGuard(
        require('#kernel/auth/subscription.guard.js').SubscriptionGuard,
      )
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(WorkflowsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('generate', () => {
    it('delegates to service and returns result', async () => {
      const req = makeRequest();
      const body = { templateId: 'nestjs-be', serviceName: 'my-service' };

      const result = await controller.generate(req, body);

      expect(service.generate).toHaveBeenCalledWith('user-1', body);
      expect(result).toEqual({ yaml: 'name: test', metadata: {} });
    });

    it('throws UnauthorizedException when no user in session', async () => {
      const req = makeUnauthRequest();
      await expect(
        controller.generate(req, {
          templateId: 'nestjs-be',
          serviceName: 'my-service',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('history', () => {
    it('returns items from service', async () => {
      const req = makeRequest();
      const result = await controller.history(req, '10');

      expect(service.getHistory).toHaveBeenCalledWith('user-1', 10);
      expect(result).toEqual({ items: [] });
    });

    it('defaults limit to 25 when not provided', async () => {
      const req = makeRequest();
      await controller.history(req);

      expect(service.getHistory).toHaveBeenCalledWith('user-1', 25);
    });

    it('throws UnauthorizedException when no user in session', async () => {
      const req = makeUnauthRequest();
      await expect(controller.history(req)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
