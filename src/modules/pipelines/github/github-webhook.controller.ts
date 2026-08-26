import { Body, Controller, Headers, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { GithubService } from './github.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('github/webhooks')
export class GithubWebhookController {
  constructor(private readonly githubService: GithubService) {}

  @Post()
  handleWebhook(
    @Req() request: RawBodyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') eventName: string | undefined,
    @Headers('x-github-delivery') deliveryId: string | undefined,
    @Body() payload: unknown,
  ) {
    return this.githubService.handleWebhook(
      signature,
      eventName,
      deliveryId,
      request.rawBody,
      payload,
    );
  }
}
