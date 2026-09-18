import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SkipTenantContext } from '#kernel/tenancy/skip-tenant-context.decorator.js';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto';
import { FeedbackService } from '../application/feedback.service';

/**
 * Customer-facing feedback endpoints. Admin triage lives in the admin module —
 * this controller only lets a signed-in user submit and view THEIR OWN feedback.
 */
@Controller('feedback')
@UseGuards(SessionAuthGuard)
@SkipTenantContext()
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  submit(@Req() req: Request, @Body() dto: SubmitFeedbackDto) {
    return this.feedbackService.submit(this.requireUserId(req), dto);
  }

  @Get('me')
  listMine(@Req() req: Request) {
    return this.feedbackService.listForUser(this.requireUserId(req));
  }

  private requireUserId(req: Request): string {
    const userId = req.session?.user?.id ?? req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
