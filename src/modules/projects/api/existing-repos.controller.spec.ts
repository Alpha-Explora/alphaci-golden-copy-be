import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Request } from 'express';

import { ExistingReposController } from './existing-repos.controller.js';
import { ExistingReposService } from '../application/existing-repos/existing-repos.service.js';

const fakeUser = { id: 'user-1', login: 'tone' };

const makeRequest = (user: typeof fakeUser | undefined = fakeUser) =>
  ({
    session: {
      user,
      userId: user?.id,
      githubAccessToken: 'oauth-token',
    },
  }) as unknown as Request;

const makeUnauthRequest = () => ({ session: {} }) as unknown as Request;

const makeService = () =>
  ({
    discover: jest.fn().mockResolvedValue({
      repoFullName: 'tone/app',
      baseBranch: 'main',
      detectedProjectTypeId: 'nextjs',
      recommendedWorkflowRecipeId: 'standard',
      serviceName: 'app',
      servicePath: '.',
    }),
    setupPullRequest: jest.fn().mockResolvedValue({
      repoFullName: 'tone/app',
      branchName: 'alphaci/app-ci',
      workflowPath: '.github/workflows/ci.yml',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/app/pull/42',
    }),
  }) as unknown as ExistingReposService;

describe('ExistingReposController', () => {
  let controller: ExistingReposController;
  let service: ExistingReposService;

  beforeEach(async () => {
    service = makeService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExistingReposController],
      providers: [{ provide: ExistingReposService, useValue: service }],
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

    controller = module.get(ExistingReposController);
  });

  it('delegates repo discovery with session user and OAuth token', async () => {
    const body = { repoFullName: 'tone/app', baseBranch: 'main' };

    await controller.discover(makeRequest(), body);

    expect(service.discover).toHaveBeenCalledWith(
      'user-1',
      'oauth-token',
      body,
    );
  });

  it('delegates setup PR creation with session user and OAuth token', async () => {
    const body = {
      repoFullName: 'tone/app',
      baseBranch: 'main',
      projectTypeId: 'nextjs',
      workflowRecipeId: 'standard',
      serviceName: 'app',
      servicePath: '.',
      outputFileName: 'ci.yml',
    };

    const result = await controller.setupPullRequest(makeRequest(), body);

    expect(service.setupPullRequest).toHaveBeenCalledWith(
      'user-1',
      'oauth-token',
      body,
    );
    expect(result).toMatchObject({
      pullRequestUrl: 'https://github.com/tone/app/pull/42',
    });
  });

  it('throws when no session user is available', async () => {
    await expect(
      controller.discover(makeUnauthRequest(), {
        repoFullName: 'tone/app',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
