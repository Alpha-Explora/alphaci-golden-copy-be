import { Injectable } from '@nestjs/common';

import { ProjectPreviewsService } from '../project-previews.service';
import type { ProjectPreviewsResponse } from '../project-previews.types';
import type { DeploymentProjectReference } from '../../deployments/index.js';

/** Application boundary for the project preview read model. */
@Injectable()
export class ProjectPreviewsApplicationService {
  constructor(private readonly previewsService: ProjectPreviewsService) {}

  listPreviews(
    project: DeploymentProjectReference,
  ): Promise<ProjectPreviewsResponse> {
    return this.previewsService.listPreviews(project);
  }
}
