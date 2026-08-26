import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { GithubService } from '#modules/pipelines/index.js';
import { ListCatalogQueryDto } from '../application/catalog/dto/list-catalog-query.dto';
import { CatalogService } from '../application/catalog/catalog.service';

@Controller('catalog')
@UseGuards(SessionAuthGuard)
export class CatalogController {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly githubService: GithubService,
  ) {}

  /**
   * `enforcedOrg` rides along on this response (rather than a new endpoint)
   * so the FE has a single, already-fetched source for the org every
   * repository must belong to — used to filter the Setup-flow repo picker
   * and to label already-attached repos outside it as "External".
   */
  @Get('project-options')
  getProjectOptions() {
    return {
      ...this.catalogService.getProjectOptions(),
      enforcedOrg: this.githubService.getEnforcedOrg(),
    };
  }

  @Get('central-workflow-tags')
  async centralWorkflowTags() {
    return this.catalogService.getCentralWorkflowTags();
  }

  @Get('categories')
  async categories() {
    return {
      categories: await this.catalogService.listCategories(),
    };
  }

  @Get('templates')
  async templates(@Query() query: ListCatalogQueryDto) {
    return {
      templates: await this.catalogService.listTemplates(query),
    };
  }

  @Get('templates/:templateId')
  async templateById(@Param('templateId') templateId: string) {
    const template = await this.catalogService.getTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template '${templateId}' not found`);
    }

    return {
      template,
    };
  }
}
