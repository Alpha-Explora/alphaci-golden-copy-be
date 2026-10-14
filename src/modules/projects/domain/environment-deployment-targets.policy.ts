/** A creation-time target, optionally limited to one environment. */
export interface EnvironmentScopedTarget {
  slot: string;
  provider: string;
  environmentSlug?: string | undefined;
}

/**
 * The targets one environment is created with: its own target for a slot
 * where it has one, and otherwise the target every environment shares. This
 * is how test and UAT run on hosted providers while production runs on an
 * on-prem host.
 */
export function targetsForEnvironment<Target extends EnvironmentScopedTarget>(
  targets: readonly Target[],
  environmentSlug: string,
): Target[] {
  const own = targets.filter(
    (target) => target.environmentSlug === environmentSlug,
  );
  return [
    ...own,
    ...targets.filter(
      (target) =>
        !target.environmentSlug &&
        !own.some(({ slot }) => slot === target.slot),
    ),
  ];
}

/**
 * Why a project's creation targets cannot be provisioned, or null. Checked
 * before the repository exists, so a refused request leaves nothing behind.
 */
export function environmentTargetsProblem(
  environments: readonly { slug: string }[] | undefined,
  targets: readonly EnvironmentScopedTarget[],
  deliveredByHost: (provider: string) => boolean,
): string | null {
  if (!environments) {
    if (targets.some(({ environmentSlug }) => environmentSlug)) {
      return 'A target can name an environmentSlug only when the project defines its environments.';
    }
    if (targets.some(({ provider }) => deliveredByHost(provider))) {
      return 'On-prem targets need project environments; add an environments list.';
    }
    return null;
  }

  const slugs = new Set(environments.map(({ slug }) => slug));
  const unknown = targets.find(
    ({ environmentSlug }) => environmentSlug && !slugs.has(environmentSlug),
  );
  if (unknown) {
    return 'No environment is named ' + String(unknown.environmentSlug) + '.';
  }
  const seen = new Set<string>();
  for (const target of targets) {
    const key = (target.environmentSlug ?? '') + '/' + target.slot;
    if (seen.has(key)) {
      return (
        'Two ' +
        target.slot +
        ' targets were given for ' +
        (target.environmentSlug ?? 'every environment') +
        '.'
      );
    }
    seen.add(key);
  }
  for (const { slug } of environments) {
    const deliveries = new Set(
      targetsForEnvironment(targets, slug).map(({ provider }) =>
        deliveredByHost(provider),
      ),
    );
    if (deliveries.size > 1) {
      return (
        slug +
        ' would have both on-prem and hosted targets; every target in an environment must be delivered the same way.'
      );
    }
  }
  return null;
}
