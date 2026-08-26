import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard';
import { DiscoverExistingRepoDto } from '../application/existing-repos/dto/discover-existing-repo.dto';
import { SetupExistingRepoPrDto } from '../application/existing-repos/dto/setup-existing-repo-pr.dto';
import { ExistingReposService } from '../application/existing-repos/existing-repos.service';

@Controller('existing-repos')
export class ExistingReposController {
  constructor(private readonly existingReposService: ExistingReposService) {}

  @Post('discover')
  @UseGuards(SessionAuthGuard, SubscriptionGuard)
  async discover(@Req() req: Request, @Body() body: DiscoverExistingRepoDto) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.existingReposService.discover(
      userId,
      req.session.githubAccessToken ?? null,
      body,
    );
  }

  @Post('setup-pr')
  @UseGuards(SessionAuthGuard, SubscriptionGuard)
  async setupPullRequest(
    @Req() req: Request,
    @Body() body: SetupExistingRepoPrDto,
  ) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.existingReposService.setupPullRequest(
      userId,
      req.session.githubAccessToken ?? null,
      body,
    );
  }
}
