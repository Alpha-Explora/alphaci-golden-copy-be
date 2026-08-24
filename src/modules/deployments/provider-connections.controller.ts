import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Req,
  Get,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import type { CreateProviderConnectionDto } from './dto/create-provider-connection.dto';
import { EnvFeatureGuard } from './env-feature.guard';
import { ProviderConnectionsService } from './provider-connections.service';

@Controller('provider-connections')
@UseGuards(SessionAuthGuard, SubscriptionGuard, EnvFeatureGuard)
export class ProviderConnectionsController {
  constructor(private readonly service: ProviderConnectionsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.service.listProviderConnections(req.session.user!.id);
  }

  @Post()
  create(@Req() req: Request, @Body() body: CreateProviderConnectionDto) {
    return this.service.createProviderConnection(req.session.user!.id, body);
  }

  @Delete(':id')
  revoke(@Req() req: Request, @Param('id') id: string) {
    return this.service.revokeProviderConnection(id, req.session.user!.id);
  }
}
