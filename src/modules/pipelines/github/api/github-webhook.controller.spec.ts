import type { Request } from 'express';

import { GithubWebhookController } from './github-webhook.controller';
import { GithubService } from '../infrastructure/github.service';

describe('GithubWebhookController', () => {
  it('skips the default throttler on the controller', () => {
    expect(
      Reflect.getMetadata('THROTTLER:SKIPdefault', GithubWebhookController),
    ).toBe(true);
  });

  it('forwards headers, raw body, and payload to GithubService', async () => {
    const githubService = {
      handleWebhook: jest.fn().mockResolvedValue({ accepted: true }),
    };
    const controller = new GithubWebhookController(
      githubService as unknown as GithubService,
    );
    const rawBody = Buffer.from('{}');
    const request = { rawBody } as unknown as Request;

    await expect(
      controller.handleWebhook(
        request,
        'sha256=sig',
        'installation',
        'delivery-1',
        { action: 'created' },
      ),
    ).resolves.toEqual({ accepted: true });

    expect(githubService.handleWebhook).toHaveBeenCalledWith(
      'sha256=sig',
      'installation',
      'delivery-1',
      rawBody,
      { action: 'created' },
    );
  });
});
