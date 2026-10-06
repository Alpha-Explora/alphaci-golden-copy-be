import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

import type {
  VisualApprovalInput,
  VisualImageQuery,
  VisualRegressionPort,
  VisualRunFacts,
  VisualSnapshotFacts,
} from '#kernel/ports/visual-regression.port';
import type {
  VisualResultFileFieldsDto,
  VisualSummaryBodyDto,
} from '../api/dto/visual.dto';
import {
  VisualRegressionRepository,
  type VisualBaselineMetaRow,
} from '../infrastructure/visual-regression.repository';
import {
  VISUAL_INHERIT_FROM_BRANCH,
  VISUAL_MAX_PNG_BYTES,
  VISUAL_MAX_SNAPSHOTS_PER_RUN,
  baselineBranchesFor,
  hasPngSignature,
} from './visual-regression.rules';

/** One entry of `GET /ci/visual-baselines`. */
export interface VisualBaselineListing {
  name: string;
  sha256: string;
  /** An API path (with the /api/v1 prefix) the workflow GETs, with the same bearer, for image/png. */
  url: string;
  /** Present only when `main` has no baseline of its own and uses uat's. */
  inheritedFrom?: 'uat';
}

/** The uploaded file as multer's memory storage hands it over. */
export interface UploadedVisualFile {
  buffer: Buffer;
  size: number;
}

/**
 * ALPHACI-stored visual baselines: what the generated Playwright job reads
 * before a run and reports after it, and what the Visual tab reads and
 * approves (through VISUAL_REGRESSION_PORT).
 *
 * Callers pass the CANONICAL repository name (the one stored on the project,
 * returned by token validation), never the caller's spelling of it.
 */
@Injectable()
export class VisualRegressionService implements VisualRegressionPort {
  constructor(private readonly repository: VisualRegressionRepository) {}

  // ─── Called by the pipeline (bearer-token authenticated) ─────────────────

  /**
   * The approved baselines the run should compare against, without bytes.
   * `main` also receives uat's approved set for every name it has no baseline
   * of its own for, marked `inheritedFrom: 'uat'`: production is reached by
   * promotion from uat, so what uat's reviewers approved is the right
   * reference until main approves something different.
   */
  async listBaselinesForPipeline(
    repoFullName: string,
    branch: string,
  ): Promise<{ baselines: VisualBaselineListing[] }> {
    const metas = await this.repository.listBaselineMeta(
      repoFullName,
      baselineBranchesFor(branch),
    );
    const resolved = this.resolveBaselines(branch, metas);

    return {
      baselines: [...resolved.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, meta]) => ({
          name,
          sha256: meta.sha256,
          // The URL names the REQUESTED branch, not the branch the bytes come
          // from: the file endpoint applies the same fallback, so a baseline
          // approved on uat later and then on main resolves without the
          // pipeline having to know either.
          url: `/api/v1/ci/visual-baselines/file?repoFullName=${encodeURIComponent(repoFullName)}&branch=${encodeURIComponent(branch)}&name=${encodeURIComponent(name)}`,
          ...(meta.branch !== branch &&
            meta.branch === VISUAL_INHERIT_FROM_BRANCH && {
              inheritedFrom: VISUAL_INHERIT_FROM_BRANCH,
            }),
        })),
    };
  }

  /** The baseline PNG the pipeline asked for, with the same main -> uat fallback. */
  async readBaselineForPipeline(
    repoFullName: string,
    branch: string,
    name: string,
  ): Promise<Buffer> {
    for (const candidate of baselineBranchesFor(branch)) {
      const png = await this.repository.getBaselinePng(
        repoFullName,
        candidate,
        name,
      );
      if (png) return png;
    }
    throw new NotFoundException('No baseline exists for that snapshot name.');
  }

  /**
   * Record one run's snapshot statuses for a browser. A later attempt of the
   * same run replaces the earlier one; a stale earlier attempt is ignored.
   */
  async ingestSummary(
    repoFullName: string,
    body: VisualSummaryBodyDto,
  ): Promise<{ received: true }> {
    const names = new Set<string>();
    for (const snapshot of body.snapshots) {
      if (names.has(snapshot.name)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'VISUAL_DUPLICATE_SNAPSHOT',
          message: `Snapshot "${snapshot.name}" appears more than once.`,
        });
      }
      names.add(snapshot.name);
    }

    const key = {
      repoFullName,
      branch: body.branch,
      runId: body.runId,
      browser: body.browser,
    };
    await this.repository.replaceSnapshots(
      key,
      body.commitSha,
      body.runAttempt,
      body.snapshots.map(({ name, status }) => ({ name, status })),
    );
    await this.repository.pruneRuns(repoFullName, body.branch);

    return { received: true };
  }

  /** Store one actual/diff screenshot of a run. */
  async ingestFile(
    repoFullName: string,
    fields: VisualResultFileFieldsDto,
    file: UploadedVisualFile | undefined,
  ): Promise<{ received: true; sha256: string }> {
    if (!file?.buffer || file.size === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VISUAL_FILE_REQUIRED',
        message: 'A PNG must be uploaded in the "file" field.',
      });
    }
    if (file.size > VISUAL_MAX_PNG_BYTES) {
      throw new PayloadTooLargeException(
        `Screenshots are limited to ${String(VISUAL_MAX_PNG_BYTES / (1024 * 1024))} MB.`,
      );
    }
    // The content type a client declares is not evidence of anything: check
    // the bytes, so a non-image can never be stored and served back as one.
    if (!hasPngSignature(file.buffer)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VISUAL_NOT_PNG',
        message: 'The uploaded file is not a PNG image.',
      });
    }

    const key = {
      repoFullName,
      branch: fields.branch,
      runId: Number(fields.runId),
      browser: fields.browser,
    };

    const known = await this.repository.countRunNames(key, fields.name);
    if (!known.present && known.total >= VISUAL_MAX_SNAPSHOTS_PER_RUN) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VISUAL_TOO_MANY_SNAPSHOTS',
        message: `A run accepts at most ${String(VISUAL_MAX_SNAPSHOTS_PER_RUN)} snapshots per browser.`,
      });
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    await this.repository.upsertImage({
      ...key,
      commitSha: fields.commitSha,
      name: fields.name,
      kind: fields.kind,
      png: file.buffer,
      sha256,
    });
    await this.repository.pruneRuns(repoFullName, fields.branch);

    return { received: true, sha256 };
  }

  // ─── VisualRegressionPort (called by Projects after its own access checks) ─

  async getRun(
    repoFullName: string,
    branch: string,
    runId?: number,
  ): Promise<VisualRunFacts | null> {
    const header = await this.repository.findRunHeader(
      repoFullName,
      branch,
      runId,
    );
    if (!header) return null;

    const [rows, baselineMetas] = await Promise.all([
      this.repository.listRunSnapshots({
        repoFullName,
        branch,
        runId: header.runId,
        browser: header.browser,
      }),
      this.repository.listBaselineMeta(
        repoFullName,
        baselineBranchesFor(branch),
      ),
    ]);
    const baselines = this.resolveBaselines(branch, baselineMetas);

    const snapshots: VisualSnapshotFacts[] = rows.map((row) => {
      const baseline = baselines.get(row.name) ?? null;
      const inherited = baseline !== null && baseline.branch !== branch;
      return {
        name: row.name,
        status: row.status,
        baseline: baseline
          ? {
              sha256: baseline.sha256,
              approvedByLogin: baseline.approvedByLogin,
              approvedAt: baseline.approvedAt,
              inheritedFrom: inherited ? VISUAL_INHERIT_FROM_BRANCH : null,
            }
          : null,
        hasActual: row.hasActual,
        hasDiff: row.hasDiff,
        approved:
          baseline !== null &&
          !inherited &&
          row.actualSha256 !== null &&
          baseline.sha256 === row.actualSha256,
      };
    });

    return {
      branch,
      runId: header.runId,
      commitSha: header.commitSha,
      reportedAt: header.reportedAt,
      browser: header.browser,
      snapshots,
    };
  }

  async readImage(query: VisualImageQuery): Promise<Buffer | null> {
    if (query.kind === 'baseline') {
      for (const candidate of baselineBranchesFor(query.branch)) {
        const png = await this.repository.getBaselinePng(
          query.repoFullName,
          candidate,
          query.name,
        );
        if (png) return png;
      }
      return null;
    }

    if (query.runId === undefined) return null;
    // Same browser choice as getRun, so the image always belongs to the
    // snapshot the tab is showing.
    const header = await this.repository.findRunHeader(
      query.repoFullName,
      query.branch,
      query.runId,
    );
    if (!header) return null;

    return this.repository.getRunImagePng(
      {
        repoFullName: query.repoFullName,
        branch: query.branch,
        runId: header.runId,
        browser: header.browser,
      },
      query.name,
      query.kind,
    );
  }

  async approve(input: VisualApprovalInput): Promise<string[]> {
    const names = [...new Set(input.names)];
    const header = await this.repository.findRunHeader(
      input.repoFullName,
      input.branch,
      input.runId,
    );
    if (!header) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'VISUAL_RUN_NOT_FOUND',
        message: 'That visual run is not available (it may have aged out).',
      });
    }

    // Only the newest reported run may be approved: approving an older run
    // would copy its (stale) images over a newer approval.
    const latest = await this.repository.findRunHeader(
      input.repoFullName,
      input.branch,
    );
    if (latest && latest.runId !== header.runId) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'VISUAL_RUN_SUPERSEDED',
        message: 'A newer visual run exists for this branch; approve that one.',
        latestRunId: latest.runId,
      });
    }

    const key = {
      repoFullName: input.repoFullName,
      branch: input.branch,
      runId: header.runId,
      browser: header.browser,
    };
    const rows = new Map(
      (await this.repository.listRunSnapshots(key)).map((row) => [
        row.name,
        row,
      ]),
    );
    const notApprovable = names.filter((name) => {
      const row = rows.get(name);
      return !row || row.status === 'passed' || !row.hasActual;
    });
    if (notApprovable.length > 0) {
      throw this.notApprovable(notApprovable);
    }

    const approved = await this.repository.promoteActualsToBaselines({
      ...key,
      names,
      approvedByUserId: input.approvedByUserId,
      approvedByLogin: input.approvedByLogin,
    });
    if (approved.length !== names.length) {
      // A snapshot changed between the check and the write (a re-run replaced
      // it). The statement is atomic, so report what did not qualify.
      const done = new Set(approved);
      throw this.notApprovable(names.filter((name) => !done.has(name)));
    }

    return names;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * One baseline per name for `branch`: its own when it has one, else (main
   * only) uat's. Rows arrive ordered by name then branch; the branch's own
   * row always wins.
   */
  private resolveBaselines(
    branch: string,
    metas: VisualBaselineMetaRow[],
  ): Map<string, VisualBaselineMetaRow> {
    const resolved = new Map<string, VisualBaselineMetaRow>();
    for (const meta of metas) {
      const current = resolved.get(meta.name);
      if (!current || meta.branch === branch) {
        resolved.set(meta.name, meta);
      }
    }
    return resolved;
  }

  private notApprovable(names: string[]): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'VISUAL_NOT_APPROVABLE',
      message:
        'Only changed or new snapshots that have a captured image can be approved.',
      names,
    });
  }
}
