import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { ReleaseRegistryService } from '../application/release-registry.service';
import { ReportDeploymentStatusDto } from './dto/release-registry.dto';
import { OnpremMachineRateLimit } from './onprem-machine-throttler.guard';

/**
 * The surface an on-prem host agent polls, outbound only. Authenticated by a
 * host token scoped to one environment, so it carries no session or
 * capability decoration; it is listed in capability-route-coverage.spec.ts.
 */
@Controller('onprem')
export class OnpremAgentController {
  constructor(private readonly releases: ReleaseRegistryService) {}

  @Get('assignments')
  @OnpremMachineRateLimit()
  assignments(@Headers('authorization') authorization: string | undefined) {
    return this.releases.hostAssignments(bearer(authorization));
  }

  @Post('deployments/:deploymentId/status')
  @OnpremMachineRateLimit()
  reportStatus(
    @Headers('authorization') authorization: string | undefined,
    @Param('deploymentId', ParseUUIDPipe) deploymentId: string,
    @Body() body: ReportDeploymentStatusDto,
  ) {
    return this.releases.reportHostStatus(
      bearer(authorization),
      deploymentId,
      body.status,
      body.detail ?? null,
    );
  }
}

function bearer(authorization: string | undefined): string {
  const [scheme, value] = (authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value?.trim()) {
    throw new UnauthorizedException('A host token is required');
  }
  return value.trim();
}
