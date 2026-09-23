/**
 * scripts/check-vercel-managed-setup.ts
 *
 * Read-only preflight for ALPHACI-managed Vercel provisioning.
 *
 * Creating a project provisions its frontend on Vercel automatically. When it
 * cannot, the project is still created and still reports `provisioned` — the
 * reason is recorded on the create result and in the project's audit trail,
 * which is easy to walk past. What you see later is a repository with no
 * VERCEL_* secrets, no VERCEL_ALIAS variable, and a verify stage complaining
 * about the variable rather than about the cause.
 *
 * This asks Vercel the same questions provisioning asks, in the same order,
 * with the same environment, and says which one fails.
 *
 * The distinction that matters: a billing-restricted or under-privileged token
 * keeps answering READS while refusing WRITES, so every check below can pass
 * and provisioning still fail. `--probe-write` is the only way to prove the
 * write path, and it is opt-in because it really does create a project (and
 * then delete it).
 *
 * Usage:
 *   npm run check:vercel                  # read-only
 *   npm run check:vercel -- --probe-write # also creates and deletes a project
 *
 * Run it from the backend repository. It reads `.env.local` and `.env` the way
 * the backend does, and an exported variable still wins — so run it in the same
 * shell you start the backend in when the configuration lives there:
 *   ALPHACI_VERCEL_TOKEN     (or FLOWCI_VERCEL_TOKEN)     — required
 *   ALPHACI_VERCEL_TEAM_ID   (or FLOWCI_VERCEL_TEAM_ID)   — required
 *   ALPHACI_VERCEL_TEAM_SLUG (optional, for preview URLs)
 *   ALPHACI_VERCEL_MANAGED_FLEET_MAX (optional platform-wide cap)
 *
 * Prints no secret: the token is used, never echoed.
 */

/*
 * The same files, in the same order, that the backend's ConfigModule reads —
 * so running this in the repository answers for the backend started from that
 * repository. A shell that exports the values wins over both, exactly as it
 * does for the running service.
 *
 * Without this the script would report "not configured" for a deployment whose
 * configuration lives in a file, which is the one wrong answer it must never
 * give.
 */
import * as dotenv from 'dotenv';

for (const file of ['.env', '.env.local']) {
  dotenv.config({ path: file, quiet: true });
}

const API = 'https://api.vercel.com';

const token = (
  process.env['ALPHACI_VERCEL_TOKEN'] ??
  process.env['FLOWCI_VERCEL_TOKEN'] ??
  ''
).trim();
const teamId = (
  process.env['ALPHACI_VERCEL_TEAM_ID'] ??
  process.env['FLOWCI_VERCEL_TEAM_ID'] ??
  ''
).trim();
const teamSlug = (process.env['ALPHACI_VERCEL_TEAM_SLUG'] ?? '').trim();
const fleetMax = (process.env['ALPHACI_VERCEL_MANAGED_FLEET_MAX'] ?? '').trim();

const probeWrite = process.argv.includes('--probe-write');

let failed = false;

function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

function bad(message: string, remedy?: string): void {
  failed = true;
  console.log(`  ✗ ${message}`);
  if (remedy) console.log(`      → ${remedy}`);
}

async function detail(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const trimmed = body.slice(0, 300);
  return `${String(response.status)}${trimmed ? ` ${trimmed}` : ''}`;
}

function scoped(path: string): string {
  const url = new URL(`${API}${path}`);
  if (teamId) url.searchParams.set('teamId', teamId);
  return url.toString();
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Whether this environment is the backend's at all.
 *
 * "ALPHACI_VERCEL_TOKEN is not set" means two very different things: the
 * deployment is missing its Vercel credentials, or the check was run in a shell
 * that was never given any configuration. Without this the reader cannot tell
 * them apart, and the second one reads like a diagnosis.
 */
function reportEnvironmentContext(): void {
  const siblings = [
    'ALPHACI_RENDER_API_KEY',
    'FLOWCI_RENDER_API_KEY',
    'GITHUB_APP_ID',
    'SUPABASE_URL',
    'SUPABASE_DB_URL',
    'SESSION_SECRET',
  ];
  const present = siblings.filter((name) => (process.env[name] ?? '').trim());

  console.log('Environment');
  if (present.length === 0) {
    console.log(
      '  ! none of the backend\'s other settings are here either (Render, GitHub, Supabase, session).',
    );
    console.log(
      '      → This shell is probably not the one the backend starts from, so the result below',
    );
    console.log(
      '        describes this shell rather than the deployment. Re-run it where the backend runs.',
    );
  } else {
    console.log(
      `  ✓ this looks like the backend's environment (${String(present.length)} of its other settings are present)`,
    );
  }
  console.log('');
}

function reportConfiguration(): boolean {
  console.log('Configuration');
  if (token) {
    ok('ALPHACI_VERCEL_TOKEN is set');
  } else {
    bad(
      'ALPHACI_VERCEL_TOKEN is not set',
      'Without it provisioning throws before it reaches Vercel, so the frontend gets no project, no secrets and no VERCEL_ALIAS.',
    );
  }

  if (teamId) {
    ok('ALPHACI_VERCEL_TEAM_ID is set');
  } else {
    bad(
      'ALPHACI_VERCEL_TEAM_ID is not set',
      'Managed Vercel targets are refused without it: "ALPHACI_VERCEL_TEAM_ID is required for ALPHACI-managed Vercel deployment targets".',
    );
  }

  console.log(
    teamSlug
      ? `  ✓ ALPHACI_VERCEL_TEAM_SLUG is set (${teamSlug})`
      : '  · ALPHACI_VERCEL_TEAM_SLUG is unset — optional',
  );

  const cap = Number(fleetMax || '0');
  if (Number.isFinite(cap) && cap > 0) {
    console.log(
      `  · ALPHACI_VERCEL_MANAGED_FLEET_MAX is ${String(cap)} — provisioning refuses new managed projects once the platform holds that many`,
    );
  }

  return Boolean(token && teamId);
}

async function checkToken(): Promise<void> {
  const response = await fetch(`${API}/v2/user`, { headers: headers() });
  if (!response.ok) {
    bad(
      `the token was refused by Vercel (${await detail(response)})`,
      'Reissue it at vercel.com/account/tokens and set it where the backend reads it.',
    );
    return;
  }

  const payload = (await response.json()) as {
    user?: { username?: string; email?: string };
  };
  ok(`the token authenticates as ${payload.user?.username ?? 'a Vercel user'}`);
}

async function checkTeam(): Promise<void> {
  const response = await fetch(`${API}/v2/teams/${teamId}`, {
    headers: headers(),
  });
  if (!response.ok) {
    bad(
      `the token cannot read the team in ALPHACI_VERCEL_TEAM_ID (${await detail(response)})`,
      "Check the id, and that the token's owner is a member of that team with a scope that covers it.",
    );
    return;
  }

  const team = (await response.json()) as { name?: string; slug?: string };
  ok(`the team is reachable: ${team.name ?? team.slug ?? teamId}`);
  if (teamSlug && team.slug && team.slug !== teamSlug) {
    bad(
      `ALPHACI_VERCEL_TEAM_SLUG says "${teamSlug}" but the team's slug is "${team.slug}"`,
      'Preview URLs are built from the slug, so a wrong one sends browsers to an address that does not exist.',
    );
  }
}

async function checkProjectsRead(): Promise<void> {
  const response = await fetch(scoped('/v9/projects?limit=1'), {
    headers: headers(),
  });
  if (!response.ok) {
    bad(`the team's projects cannot be listed (${await detail(response)})`);
    return;
  }

  const payload = (await response.json()) as { projects?: unknown[] };
  ok(
    `projects are readable (${String(payload.projects?.length ?? 0)} returned by a 1-project probe)`,
  );
}

/**
 * The only check that proves provisioning would work.
 *
 * An overdue invoice, a role below Admin and a token scoped to another team all
 * answer reads normally and refuse this.
 */
async function probeCreateAndDelete(): Promise<void> {
  const name = `alphaci-preflight-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`  · creating a throwaway project "${name}"`);

  const created = await fetch(scoped('/v11/projects'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name }),
  });

  if (!created.ok) {
    bad(
      `Vercel refused to create a project (${await detail(created)})`,
      'This is the write path provisioning uses. Check, in this order: an overdue invoice on the Vercel account, the token owner being at least an Admin of the team, and the token scope covering that team.',
    );
    return;
  }

  const project = (await created.json()) as { id?: string };
  ok('a project can be created — provisioning would have succeeded');

  const removed = await fetch(scoped(`/v9/projects/${project.id ?? name}`), {
    method: 'DELETE',
    headers: headers(),
  });
  console.log(
    removed.ok || removed.status === 404
      ? '  ✓ the throwaway project was deleted'
      : `  ! the throwaway project could NOT be deleted (${await detail(removed)}) — remove "${name}" by hand`,
  );
}

async function main(): Promise<void> {
  console.log('ALPHACI managed Vercel preflight\n');

  reportEnvironmentContext();
  const configured = reportConfiguration();
  if (!configured) {
    console.log(
      '\nVerdict: managed Vercel is NOT configured for this backend, so creating a project cannot put its frontend on Vercel.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nVercel');
  await checkToken();
  await checkTeam();
  await checkProjectsRead();

  if (probeWrite) {
    console.log('\nWrite probe');
    await probeCreateAndDelete();
  } else {
    console.log(
      '\n  · reads only. A billing-restricted or under-privileged token passes every check above and still refuses to create a project —',
    );
    console.log(
      '    run `npm run check:vercel -- --probe-write` to prove the write path.',
    );
  }

  console.log(
    failed
      ? '\nVerdict: managed Vercel provisioning would FAIL for the reason marked above.'
      : '\nVerdict: managed Vercel is configured and reachable.',
  );
  process.exitCode = failed ? 1 : 0;
}

void main().catch((error: unknown) => {
  console.error('The preflight could not run:', error);
  process.exitCode = 1;
});
