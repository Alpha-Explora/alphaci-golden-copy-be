import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { CapabilityGuard } from '#kernel/composition/index.js';
import { ProjectIterationsService } from '../application/qa-checklists/project-iterations.service';
import { DeliveryProjectIterationsController } from './project-iterations.controller';

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

async function createApp(session: unknown = { user: { id: 'user-1' } }) {
  const iterations = {
    listForProject: jest.fn().mockResolvedValue({ iterations: [iteration] }),
    currentForProject: jest.fn().mockResolvedValue({
      iteration,
      canStartNext: false,
      deliveredRepositories: [],
    }),
  };
  const guards = jest.fn().mockReturnValue(true);
  const module = await Test.createTestingModule({
    controllers: [DeliveryProjectIterationsController],
    providers: [{ provide: ProjectIterationsService, useValue: iterations }],
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
  return { app, iterations };
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
    });
    expect(fixture.iterations.currentForProject).toHaveBeenCalledWith(
      ID,
      'user-1',
    );
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

  it('is read-only in phase 1: no write verb is routed', async () => {
    fixture = await createApp();

    await http().post(`/delivery-projects/${ID}/iterations`).expect(404);
    await http().delete(`/delivery-projects/${ID}/iterations`).expect(404);
  });
});
