import yaml from 'js-yaml';

/** The reusable workflow whose inputs decide whether visual testing runs. */
const PLAYWRIGHT_WORKFLOW = 'playwright-e2e.yml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the call hands the reusable workflow the ALPHACI_TOKEN secret. */
function passesAlphaciToken(secrets: unknown): boolean {
  if (secrets === 'inherit') return true;
  if (!isRecord(secrets)) return false;
  const token = secrets['ALPHACI_TOKEN'];
  return typeof token === 'string' && token.trim() !== '';
}

function jobTurnsVisualOn(job: Record<string, unknown>): boolean {
  const inputs = isRecord(job['with']) ? job['with'] : {};
  const apiUrl = inputs['alphaci-api-url'];
  return (
    inputs['visual-baselines'] === true &&
    typeof apiUrl === 'string' &&
    apiUrl.trim() !== '' &&
    passesAlphaciToken(job['secrets'])
  );
}

/**
 * Whether a generated verify workflow turns visual testing on.
 *
 * playwright-e2e.yml skips visual with a warning when it is not handed
 * `visual-baselines: true`, an `alphaci-api-url` and the ALPHACI_TOKEN secret,
 * so all three must be present on EVERY job that calls it: one job left on the
 * old wiring means that branch still takes no screenshots.
 *
 * `null` is "could not tell": no file, or one that does not parse as a
 * workflow. `false` is "read it, and visual is off" (including no Playwright
 * job at all). Never throws.
 */
export function readVisualTestingFlag(
  content: string | null | undefined,
): boolean | null {
  if (content === null || content === undefined || content.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(content, { schema: yaml.DEFAULT_SCHEMA });
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed['jobs'])) {
    return null;
  }

  const playwrightJobs = Object.values(parsed['jobs']).filter(
    (job): job is Record<string, unknown> =>
      isRecord(job) &&
      typeof job['uses'] === 'string' &&
      job['uses'].includes(PLAYWRIGHT_WORKFLOW),
  );
  return playwrightJobs.length > 0 && playwrightJobs.every(jobTurnsVisualOn);
}
