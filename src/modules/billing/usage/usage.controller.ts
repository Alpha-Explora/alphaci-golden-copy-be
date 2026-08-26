import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { UsageQuotaService } from './usage-quota.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usageQuotaService: UsageQuotaService) {}

  @Get('me')
  @UseGuards(SessionAuthGuard)
  async getMyUsage(@Req() req: Request) {
    const userId = req.session.user?.id ?? req.session.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return this.usageQuotaService.getUsage(userId);
  }
}
