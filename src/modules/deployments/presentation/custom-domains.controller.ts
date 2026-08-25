import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '../../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../../common/guards/subscription.guard';
import {
  CustomDomainsService,
  type AddCustomDomainInput,
} from '../application/custom-domains.service';
import { EnvFeatureGuard } from './env-feature.guard';

@Controller('projects/:projectId/domains')
// EnvFeatureGuard alongside the others: a domain attaches to a deployment
// target, so it is meaningless on a deployment where hosting is switched off.
@UseGuards(SessionAuthGuard, SubscriptionGuard, EnvFeatureGuard)
export class CustomDomainsController {
  constructor(private readonly service: CustomDomainsService) {}

  @Get()
  list(@Req() req: Request, @Param('projectId') projectId: string) {
    return this.service.listDomains(projectId, this.requireUserId(req));
  }

  @Post()
  add(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Body() body: AddCustomDomainInput,
  ) {
    return this.service.addDomain(projectId, this.requireUserId(req), body);
  }

  @Post(':domainId/verify')
  verify(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('domainId') domainId: string,
  ) {
    return this.service.verifyDomain(
      projectId,
      domainId,
      this.requireUserId(req),
    );
  }

  @Delete(':domainId')
  remove(
    @Req() req: Request,
    @Param('projectId') projectId: string,
    @Param('domainId') domainId: string,
  ) {
    return this.service.removeDomain(
      projectId,
      domainId,
      this.requireUserId(req),
    );
  }

  private requireUserId(req: Request): string {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
