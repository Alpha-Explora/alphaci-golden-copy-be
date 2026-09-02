export type LiveAdapterStatus = {
  githubShipped: boolean;
  providersShipped: boolean;
  implemented: boolean;
};

const DEFAULT_STATUS: Pick<
  LiveAdapterStatus,
  'githubShipped' | 'providersShipped'
> = {
  // ProjectCiRunsService still returns mode: 'local_mock'.
  githubShipped: false,
  // ProjectDeploymentsService still returns mode: 'local_mock' when no live fetch is attempted.
  providersShipped: false,
};

export function resolveLiveAdapterStatus(
  overrides: Partial<
    Pick<LiveAdapterStatus, 'githubShipped' | 'providersShipped'>
  > = {},
): LiveAdapterStatus {
  const githubShipped = overrides.githubShipped ?? DEFAULT_STATUS.githubShipped;
  const providersShipped =
    overrides.providersShipped ?? DEFAULT_STATUS.providersShipped;
  return {
    githubShipped,
    providersShipped,
    implemented: githubShipped && providersShipped,
  };
}
