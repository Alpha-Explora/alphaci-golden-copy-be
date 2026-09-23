import {
  clampLogLimit,
  normalizeLogLevel,
  type DeploymentLogLine,
  type DeploymentLogsWindow,
  type LogDirection,
  type LogLineType,
} from '../../../core/deployment-logs.types';

type RenderServiceUrlFields = {
  serviceDetails?: { url?: string };
  details?: { url?: string };
  url?: string;
};

export type RenderCreatedServicePayload = RenderServiceUrlFields & {
  id?: string;
  name?: string;
  service?: RenderServiceUrlFields & {
    id?: string;
    name?: string;
  };
};

export type CreatedRenderService = {
  id: string;
  name: string;
  url: string | null;
};

export type RenderServiceStatusPayload = RenderServiceUrlFields & {
  id?: string;
  name?: string;
  suspended?: string;
  ownerId?: string;
  service?: RenderServiceUrlFields & {
    id?: string;
    name?: string;
    suspended?: string;
    ownerId?: string;
  };
};

export type RenderServiceStatus = {
  url: string | null;
  state?: string;
  ownerId?: string;
};

function readServiceUrl(
  payload: RenderServiceUrlFields & {
    service?: RenderServiceUrlFields;
  },
): string | null {
  return (
    payload.service?.serviceDetails?.url ??
    payload.service?.details?.url ??
    payload.service?.url ??
    payload.serviceDetails?.url ??
    payload.details?.url ??
    payload.url ??
    null
  );
}

export function readCreatedService(
  payload: RenderCreatedServicePayload,
): CreatedRenderService | null {
  const id = payload.service?.id ?? payload.id;
  const name = payload.service?.name ?? payload.name;
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    url: readServiceUrl(payload),
  };
}

export function readServiceStatus(
  payload: RenderServiceStatusPayload,
): RenderServiceStatus {
  const state = payload.service?.suspended ?? payload.suspended;
  const ownerId = payload.service?.ownerId ?? payload.ownerId;

  return {
    url: readServiceUrl(payload),
    ...(state !== undefined ? { state } : {}),
    ...(ownerId ? { ownerId } : {}),
  };
}

const RENDER_LOG_TYPES: ReadonlySet<string> = new Set([
  'app',
  'build',
  'request',
]);

export interface RenderLogLabel {
  name?: string;
  value?: string;
}

export interface RenderLogEntryPayload {
  id?: string;
  message?: string;
  timestamp?: string;
  labels?: RenderLogLabel[];
}

export interface RenderLogsPayload {
  hasMore?: boolean;
  nextStartTime?: string;
  nextEndTime?: string;
  logs?: RenderLogEntryPayload[];
}

export interface RenderLogsPage {
  logs: DeploymentLogLine[];
  hasMore: boolean;
  next: DeploymentLogsWindow | null;
}

function renderLabelValue(
  labels: RenderLogLabel[] | undefined,
  name: string,
): string | undefined {
  return labels?.find((label) => label.name === name)?.value;
}

/**
 * Render has no top-level `level` field on a log line — level, type and
 * instance all arrive as `labels: [{ name, value }]`. Mapping this correctly
 * is the whole fix for the old getLogs() bug, which read `l.level` (always
 * undefined) and silently reported every line as 'info'.
 */
export function mapRenderLogLine(
  entry: RenderLogEntryPayload,
): DeploymentLogLine {
  const labels = entry.labels ?? [];
  const labelRecord: Record<string, string> = {};
  for (const label of labels) {
    if (label.name) {
      labelRecord[label.name] = label.value ?? '';
    }
  }
  const rawType = renderLabelValue(labels, 'type');
  const type: LogLineType | null =
    rawType && RENDER_LOG_TYPES.has(rawType) ? (rawType as LogLineType) : null;

  return {
    // Render always sends an id per the documented response shape; the
    // fallback only guards a malformed/future payload from throwing.
    id: entry.id ?? `${entry.timestamp ?? ''}:${entry.message ?? ''}`,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    message: entry.message ?? '',
    level: normalizeLogLevel(renderLabelValue(labels, 'level')),
    type,
    instance: renderLabelValue(labels, 'instance') ?? null,
    labels: labelRecord,
  };
}

export function mapRenderLogsPage(
  payload: RenderLogsPayload,
  direction: LogDirection = 'backward',
): RenderLogsPage {
  // Render's `direction` flips which end of the requested window it fills
  // from first, but the product contract is oldest -> newest on screen no
  // matter which direction was requested. A backward page arrives
  // newest-first, so it must be reversed into oldest-first BEFORE the sort
  // below: Array.prototype.sort is stable, and Date.parse only resolves to
  // millisecond precision, so two-plus lines tied at the same millisecond
  // (e.g. every line of a stack trace logged in one burst) would otherwise
  // keep Render's newest-first order and render upside down. The sort that
  // follows is only a guard against a single genuinely out-of-order line —
  // reversing first is what establishes correct order among tied lines.
  const ordered =
    direction === 'backward'
      ? [...(payload.logs ?? [])].reverse()
      : (payload.logs ?? []);
  const logs = ordered
    .map(mapRenderLogLine)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return {
    logs,
    hasMore: payload.hasMore ?? false,
    next:
      payload.nextStartTime && payload.nextEndTime
        ? { startTime: payload.nextStartTime, endTime: payload.nextEndTime }
        : null,
  };
}

export interface RenderLogsQueryInput {
  startTime?: string;
  endTime?: string;
  direction?: LogDirection;
  limit?: number;
  type?: readonly string[];
  level?: readonly string[];
  text?: string;
  instance?: readonly string[];
}

/**
 * Builds the query string for `GET /v1/logs`. Array filters (type/level/
 * instance) are sent as repeated params, matching how every other array
 * filter on this API is documented; `resource` is Render's own array field,
 * populated with just this service's id since one deployment target is
 * exactly one Render service.
 */
export function buildRenderLogsQueryParams(
  ownerId: string,
  resourceId: string,
  query: RenderLogsQueryInput,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('ownerId', ownerId);
  params.append('resource', resourceId);
  params.set('limit', String(clampLogLimit(query.limit)));
  params.set(
    'direction',
    query.direction === 'forward' ? 'forward' : 'backward',
  );
  if (query.startTime) params.set('startTime', query.startTime);
  if (query.endTime) params.set('endTime', query.endTime);
  for (const type of query.type ?? []) params.append('type', type);
  for (const level of query.level ?? []) params.append('level', level);
  for (const instance of query.instance ?? []) {
    params.append('instance', instance);
  }
  if (query.text) params.set('text', query.text);

  return params;
}
