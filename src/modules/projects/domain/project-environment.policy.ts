export type ProjectEnvironmentRole = 'production' | 'non_production';

export interface ProjectEnvironmentDefinition {
  slug: string;
  displayName: string;
  sourceBranch: string;
  role: ProjectEnvironmentRole;
}

export interface ProjectEnvironmentRecord extends ProjectEnvironmentDefinition {
  id: string;
  position: number;
  autoDeploy: boolean;
}

export type ProjectEnvironmentInput = ProjectEnvironmentDefinition;

export type ProjectEnvironmentViolation =
  | 'empty_environment_list'
  | 'duplicate_slug'
  | 'invalid_slug'
  | 'invalid_display_name'
  | 'invalid_source_branch'
  | 'invalid_role'
  | 'production_environment_count';

export function validateProjectEnvironmentDefinitions(
  environments: ProjectEnvironmentDefinition[],
): ProjectEnvironmentViolation | null {
  if (environments.length === 0) return 'empty_environment_list';

  const slugs = new Set<string>();
  let productionCount = 0;
  for (const environment of environments) {
    const violation = validateProjectEnvironmentDefinition(environment);
    if (violation) return violation;
    if (slugs.has(environment.slug)) return 'duplicate_slug';
    slugs.add(environment.slug);
    if (environment.role === 'production') productionCount += 1;
  }

  return productionCount === 1 ? null : 'production_environment_count';
}

export function validateProjectEnvironmentDefinition(
  environment: ProjectEnvironmentDefinition,
): ProjectEnvironmentViolation | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(environment.slug)) {
    return 'invalid_slug';
  }
  if (!environment.displayName.trim()) return 'invalid_display_name';
  if (!environment.sourceBranch.trim()) return 'invalid_source_branch';
  if (
    environment.role !== 'production' &&
    environment.role !== 'non_production'
  ) {
    return 'invalid_role';
  }
  return null;
}
