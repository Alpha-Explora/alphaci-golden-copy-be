import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Response } from 'express';
import { OnpremHostsService } from '../application/onprem/onprem-hosts.service';
import { ConsumeEnrollmentDto, HeartbeatDto } from './dto/onprem-host.dto';
import { OnpremMachineRateLimit } from './onprem-machine-throttler.guard';

/** Short-lived enrollment code or revocable machine credential, never session auth. */
@Controller('onprem')
export class OnpremEnrollmentController {
  constructor(
    private readonly hosts: OnpremHostsService,
    private readonly config: ConfigService,
  ) {}
  @Get('installer/:version')
  installer(@Param('version') version: string, @Res() response: Response) {
    const file = this.config.get<string>('ONPREM_INSTALLER_PATH');
    if (
      this.config.get('ONPREM_RELEASES_ENABLED') !== 'true' ||
      !file ||
      version !== this.config.get('ONPREM_INSTALLER_VERSION')
    )
      throw new NotFoundException();
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolve(file));
    } catch {
      throw new NotFoundException();
    }
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      this.config.get('ONPREM_INSTALLER_SHA256')
    )
      throw new NotFoundException(
        'Installer checksum does not match the configured release.',
      );
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="alphaci-agent-${version.replace(/[^0-9.]/g, '')}.tar.gz"`,
    );
    response.send(bytes);
  }
  @Post('enroll')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  enroll(@Body() input: ConsumeEnrollmentDto) {
    return this.hosts.consumeEnrollment(input.code, input);
  }
  @Post('heartbeat')
  @OnpremMachineRateLimit()
  heartbeat(
    @Headers('authorization') authorization: string | undefined,
    @Body() input: HeartbeatDto,
  ) {
    const match = /^Bearer (\S+)$/i.exec(authorization ?? '');
    if (!match?.[1])
      throw new UnauthorizedException('Machine credential is required.');
    return this.hosts.heartbeat(match[1], input);
  }
}
