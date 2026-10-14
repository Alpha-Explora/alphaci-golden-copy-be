import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CapabilityGuard } from '#kernel/composition/index.js';
import { ProjectIterationsService } from '../application/qa-checklists/project-iterations.service';
import { ProjectIterationStartService } from '../application/qa-runs/project-iteration-start.service';
import { QaProjectDeliveryService } from '../application/qa-runs/qa-project-delivery.service';
import { DeliveryProjectIterationsController } from './project-iterations.controller';

const U = '/delivery-projects/11111111-1111-4111-8111-111111111111/iterations';
const ID = '11111111-1111-4111-8111-111111111111';

const iteration = {
  id: 'it-1',
  number: 1,
  status: 'active',
  deliveryProjectId: ID,
  goal: null,
  startedAt: '2026-10-01T00:00:00.000Z',
  startedBy: null,
  deliveredAt: null,
  deliveredBy: null,
  signoffRunId: null,
};

async function createApp(
  session: unknown = {
    user: { id: 'user-1', login: 'tone' },
    githubAccessToken: 'gho',
  },
) {
  const iterations = {
    listForProject: jest.fn().mockResolvedValue({ iterations: [iteration] }),
  };
  const delivery = {
    current: jest.fn().mockResolvedValue({
      iteration,
      canStartNext: false,
      deliveredRepositories: [],
      coveredRepositories: [],
      canMergeAll: false,
    }),
  };
  const starter = {
    start: jest.fn().mockResolvedValue({
      iteration: { ...iteration, id: 'it-2', number: 2 },
      carriedRequirements: 1,
      carriedItems: 2,
    }),
  };
  const guards = jest.fn().mockReturnValue(true);
  const module = await Test.createTestingModule({
    controllers: [DeliveryProjectIterationsController],
    providers: [
      { provide: ProjectIterationsService, useValue: iterations },
      { provide: QaProjectDeliveryService, useValue: delivery },
      { provide: ProjectIterationStartService, useValue: starter },
    ],
  })
    .overrideGuard(SessionAuthGuard)
    .useValue({ canActivate: guards })
    .overrideGuard(CapabilityGuard)
    .useValue({ canActivate: guards })
    .compile();

  const app: INestApplication = module.createNestApplication();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = session;
    next();
  });
  await app.init();
  return { app, iterations, delivery, starter };
}

describe('DeliveryProjectIterationsController', () => {
  let fixture: Awaited<ReturnType<typeof createApp>>;

  afterEach(async () => {
    await fixture.app.close();
  });

  const http = () => request(fixture.app.getHttpServer() as Server);

  it('GET /delivery-projects/:id/iterations lists the Iterations for the signed-in user', async () => {
    fixture = await createApp();

    const response = await http()
      .get(`/delivery-projects/${ID}/iterations`)
      .expect(200);

    expect(response.body).toEqual({ iterations: [iteration] });
    expect(fixture.iterations.listForProject).toHaveBeenCalledWith(
      ID,
      'user-1',
    );
  });

  it('GET /delivery-projects/:id/iterations/current answers the current one with canStartNext and the delivered repositories', async () => {
    fixture = await createApp();

    const response = await http()
      .get(`/delivery-projects/${ID}/iterations/current`)
      .expect(200);

    expect(response.body).toEqual({
      iteration,
      canStartNext: false,
      deliveredRepositories: [],
      coveredRepositories: [],
      canMergeAll: false,
    });
    expect(fixture.delivery.current).toHaveBeenCalledWith(ID, {
      userId: 'user-1',
      userLogin: 'tone',
      oauthToken: 'gho',
    });
    // The literal segment is not captured as an id.
    expect(fixture.iterations.listForProject).not.toHaveBeenCalled();
  });

  it('a non-member gets the 404 the service throws', async () => {
    fixture = await createApp();
    fixture.iterations.listForProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );

    await http().get(`/delivery-projects/${ID}/iterations`).expect(404);
  });

  it('answers 401 when the session carries no user', async () => {
    fixture = await createApp({});

    await http().get(`/delivery-projects/${ID}/iterations`).expect(401);
    await http().get(`/delivery-projects/${ID}/iterations/current`).expect(401);
    expect(fixture.iterations.listForProject).not.toHaveBeenCalled();
  });

  it('POST /delivery-projects/:id/iterations starts the next Iteration for the signed-in user', async () => {
    fixture = await createApp();

    const response = await http()
      .post(U)
      .send({
        goal: 'Loyalty points',
        carryOver: { requirementItemIds: ['i-1'] },
      })
      .expect(201);

    expect(response.body).toMatchObject({
      iteration: { number: 2 },
      carriedRequirements: 1,
      carriedItems: 2,
    });
    expect(fixture.starter.start).toHaveBeenCalledWith(
      ID,
      { userId: 'user-1', userLogin: 'tone', oauthToken: 'gho' },
      { goal: 'Loyalty points', carryOver: { requirementItemIds: ['i-1'] } },
    );
  });

  it('POST answers 401 without a user and has no other write verb', async () => {
    fixture = await createApp({});
    await http().post(U).send({}).expect(401);
    expect(fixture.starter.start).not.toHaveBeenCalled();
    await fixture.app.close();

    fixture = await createApp();
    await http().delete(U).expect(404);
  });
});
