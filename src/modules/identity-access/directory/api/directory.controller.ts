import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { MemberDirectoryService } from '../application/member-directory.service';
import type {
  DirectoryDescription,
  DirectoryListing,
} from '../domain/directory.types';
import { directoryCallerFrom } from './directory-caller';
import { SearchDirectoryDto } from './dto/search-directory.dto';

/**
 * The deployment's member directory as an API, for the web app and for any
 * client system that needs to know who belongs to this deployment.
 */
@Controller('directory')
@UseGuards(SessionAuthGuard)
export class DirectoryController {
  constructor(private readonly directory: MemberDirectoryService) {}

  /** Which source backs the directory here, so a client can say so. */
  @Get()
  describe(): DirectoryDescription {
    return this.directory.describe();
  }

  /**
   * The people in the directory, each flagged with whether they have an
   * AlphaCI account yet. Readable only by people in the directory. 503 when
   * the source cannot be read, with the reason in `message`.
   */
  @Get('members')
  listMembers(
    @Req() req: Request,
    @Query() query: SearchDirectoryDto,
  ): Promise<DirectoryListing> {
    return this.directory.listForCaller(directoryCallerFrom(req), query);
  }
}
