import { Injectable, NotFoundException } from '@nestjs/common';

import { QaRunsRepository } from '../../infrastructure/qa-runs.repository';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import { QaAccessService } from '../qa-checklists/qa-access.service';
import { QaRunsService } from './qa-runs.service';
import type { QaRun } from './qa-runs.contracts';
import { buildQaReport, toSignoffHistoryEntry } from './qa-report.mapper';
import type { QaReport, QaReportProject } from './qa-report.contracts';

function projectDisplayName(project: ProvisionedProjectRow): string {
  const serviceName = project.service_name.trim();
  if (serviceName) {
    return serviceName;
  }
  const segments = project.repo_full_name.split('/');
  return segments[segments.length - 1] || project.repo_full_name;
}

function toReportProject(project: ProvisionedProjectRow): QaReportProject {
  return {
    id: project.id,
    repoFullName: project.repo_full_name,
    name: projectDisplayName(project),
  };
}

/**
 * Builds the QA report export (Slice 4). Authorization mirrors every other
 * qa-runs read: project visibility is a 404 (QaAccessService.findVisibleProject),
 * not a 403, and a run id that does not belong to the project is also a 404
 * -- see requireVisibleProject/requireRun in qa-runs.service.ts, the same
 * shape reused here.
 */
@Injectable()
export class QaReportService {
  constructor(
    private readonly access: QaAccessService,
    private readonly runsRepository: QaRunsRepository,
    private readonly qaRunsService: QaRunsService,
  ) {}

  async build(
    projectId: string,
    userId: string,
    runId: string,
  ): Promise<QaReport> {
    const project = await this.access.findVisibleProject(projectId, userId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const runRow = await this.runsRepository.findRunForProject(
      projectId,
      runId,
    );
    if (!runRow) {
      throw new NotFoundException('QA run not found');
    }

    // Only a SIGNED_OFF run can have a frozen report: fetch the active
    // signoff only in that case. A benign race (status flips between this
    // read and the one above) is handled the same way every other qa-runs
    // read already handles it -- see findActiveSignoff's other callers --
    // by falling back to the live assembly below rather than failing.
    const activeSignoff =
      runRow.status === 'signed_off'
        ? await this.runsRepository.findActiveSignoff(runRow.id)
        : null;

    const frozen = activeSignoff !== null;
    const run: QaRun = frozen
      ? // Signed off: EXACTLY the frozen report_json, never rebuilt.
        (activeSignoff.report_json as unknown as QaRun)
      : // Open: the same assembly GET .../qa-runs/:runId uses.
        await this.qaRunsService.getById(projectId, userId, runId);

    const supersededRows = await this.runsRepository.listSupersededSignoffs(
      runRow.id,
    );

    return buildQaReport({
      generatedAt: new Date().toISOString(),
      frozen,
      project: toReportProject(project),
      run,
      signoffHistory: supersededRows.map(toSignoffHistoryEntry),
    });
  }
}
