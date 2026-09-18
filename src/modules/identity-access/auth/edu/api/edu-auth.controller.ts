import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CapabilityGuard } from '#kernel/composition/capability.guard.js';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator.js';
import { EduAuthService } from '../application/edu-auth.service.js';
import {
  EDU_AUTH_CONFIG,
  type EduAuthConfig,
} from '../application/edu-auth.ports.js';
import { EduAuthEnabledGuard } from './guards/edu-auth-enabled.guard.js';
import { EduSessionGuard } from './guards/edu-session.guard.js';
import { EduCompletePasswordResetDto } from './dto/edu-complete-password-reset.dto.js';
import { EduLoginDto } from './dto/edu-login.dto.js';
import { EduRequestPasswordResetDto } from './dto/edu-request-password-reset.dto.js';
import { EduSelectLabDto } from './dto/edu-select-lab.dto.js';
import { EduStudentSignupDto } from './dto/edu-student-signup.dto.js';

@Throttle({ default: { ttl: 60_000, limit: 10 } })
@Controller('auth/edu')
@UseGuards(CapabilityGuard, EduAuthEnabledGuard)
@RequiresCapability('identity.edu-auth')
export class EduAuthController {
  constructor(
    private readonly eduAuthService: EduAuthService,
    @Inject(EDU_AUTH_CONFIG) private readonly config: EduAuthConfig,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  @HttpCode(200)
  login(@Req() request: Request, @Body() body: EduLoginDto) {
    return this.eduAuthService.login(request, body);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('student/signup')
  @HttpCode(200)
  studentSignup(@Body() body: EduStudentSignupDto) {
    return this.eduAuthService.studentSignup(body);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('request-password-reset')
  @HttpCode(200)
  requestPasswordReset(@Body() body: EduRequestPasswordResetDto) {
    return this.eduAuthService.requestPasswordReset(body.email);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('complete-password-reset')
  @HttpCode(200)
  completePasswordReset(@Body() body: EduCompletePasswordResetDto) {
    return this.eduAuthService.completePasswordReset(
      body.accessToken,
      body.password,
    );
  }

  @Get('me')
  @UseGuards(EduSessionGuard)
  me(@Req() request: Request) {
    return this.eduAuthService.me(request);
  }

  @Get('labs')
  @UseGuards(EduSessionGuard)
  labs(@Req() request: Request) {
    return this.eduAuthService.labs(request);
  }

  @Post('select-lab')
  @HttpCode(200)
  @UseGuards(EduSessionGuard)
  selectLab(@Req() request: Request, @Body() body: EduSelectLabDto) {
    return this.eduAuthService.selectLab(request, body.orgId);
  }

  @Get('github/start')
  @UseGuards(EduSessionGuard)
  async githubStart(
    @Req() request: Request,
    @Res() response: Response,
    @Query('returnTo') returnTo?: string,
  ) {
    const redirectUrl = await this.eduAuthService.startGithubLink(
      request,
      returnTo,
    );
    return response.redirect(redirectUrl);
  }

  @SkipThrottle()
  @Get('github/callback')
  async githubCallback(
    @Req() request: Request,
    @Res() response: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ) {
    const redirectUrl = await this.eduAuthService.handleGithubCallback(
      request,
      code,
      state,
    );
    return response.redirect(redirectUrl);
  }

  @Get('github/status')
  @UseGuards(EduSessionGuard)
  githubStatus(@Req() request: Request) {
    return this.eduAuthService.githubStatus(request);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.eduAuthService.logout(request);
    response.clearCookie(this.config.sessionCookieName);
    return { ok: true };
  }
}
