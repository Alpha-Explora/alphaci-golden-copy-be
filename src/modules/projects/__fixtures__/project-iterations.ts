import { parseDeliveryEntries } from '../domain/project-delivery.rules';
import { ProjectIterationsService } from '../application/qa-checklists/project-iterations.service';
import type { QaAccessService } from '../application/qa-checklists/qa-access.service';
import type { QaProjectContextService } from '../application/qa-checklists/qa-project-context.service';
import type {
  ProjectIterationRow,
  ProjectIterationsRepository,
} from '../infrastructure/project-iterations.repository';

export const TEST_DELIVERY_PROJECT_ID = 'dp-1';
export const TEST_ITERATION_ID = 'it-1';

export const iterationRow = (
  overrides: Partial<ProjectIterationRow> = {},
): ProjectIterationRow => ({
  id: TEST_ITERATION_ID,
  delivery_project_id: TEST_DELIVERY_PROJECT_ID,
  number: 1,
  goal: null,
  status: 'active',
  started_at: '2026-10-01T00:00:00.000Z',
  started_by: null,
  started_by_login: null,
  delivered_at: null,
  delivered_by: null,
  delivered_by_login: null,
  signoff_run_id: null,
  delivery_json: null,
  ...overrides,
});

/** A delivered Iteration, the shape phase 2 will write. */
export const deliveredIterationRow = (
  overrides: Partial<ProjectIterationRow> = {},
): ProjectIterationRow =>
  iterationRow({
    status: 'delivered',
    delivered_at: '2026-10-10T00:00:00.000Z',
    delivered_by_login: 'lead',
    ...overrides,
  });

/**
 * The REAL ProjectIterationsService over a fake repository, so a spec
 * exercises the actual guard and resolution rather than a stub of them. Pass a
 * delivered row to see every write refused.
 */
export function fakeIterations(
  iteration: ProjectIterationRow = iterationRow(),
  options: { canManage?: boolean } = {},
) {
  // The delivery writes behave like their SQL (one row, `active` guard), so a
  // spec can race two deliveries and see exactly one transition.
  const state = { row: iteration };
  const repository = {
    findById: jest.fn().mockImplementation(() => Promise.resolve(state.row)),
    recordRepositoryDelivery: jest
      .fn()
      .mockImplementation(
        (
          _id: string,
          entry: { projectId: string; uatHeadSha: string },
        ): Promise<ProjectIterationRow | null> => {
          if (state.row.status !== 'active') {
            return Promise.resolve(null);
          }
          const entries = parseDeliveryEntries(state.row.delivery_json).filter(
            (existing) =>
              !(
                existing.projectId === entry.projectId &&
                existing.uatHeadSha !== entry.uatHeadSha
              ),
          );
          const present = entries.some(
            (existing) =>
              existing.projectId === entry.projectId &&
              existing.uatHeadSha === entry.uatHeadSha,
          );
          state.row = {
            ...state.row,
            delivery_json: {
              repositories: present ? entries : [...entries, entry],
            },
          };
          return Promise.resolve(state.row);
        },
      ),
    markDelivered: jest.fn().mockImplementation(
      (
        _id: string,
        input: {
          deliveredBy: string;
          deliveredByLogin: string;
          signoffRunId: string;
          deliveryJson: unknown;
        },
      ): Promise<ProjectIterationRow | null> => {
        if (state.row.status !== 'active') {
          return Promise.resolve(null);
        }
        state.row = {
          ...state.row,
          status: 'delivered',
          delivered_at: '2026-10-15T00:00:00.000Z',
          delivered_by: input.deliveredBy,
          delivered_by_login: input.deliveredByLogin,
          signoff_run_id: input.signoffRunId,
          delivery_json: input.deliveryJson,
        };
        return Promise.resolve(state.row);
      },
    ),
    findCurrent: jest.fn().mockImplementation(() => Promise.resolve(state.row)),
    list: jest.fn().mockImplementation(() => Promise.resolve([state.row])),
    insertFirstIfNone: jest.fn().mockResolvedValue(undefined),
    startNext: jest.fn(),
    findCurrentByDeliveryProjects: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Map([[state.row.delivery_project_id, state.row]])),
      ),
  } as unknown as jest.Mocked<ProjectIterationsRepository>;
  const access = {
    canManage: jest.fn().mockResolvedValue(options.canManage ?? true),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    requireProject: jest.fn().mockResolvedValue({
      deliveryProjectId: iteration.delivery_project_id,
      groupId: 'group-1',
      name: 'Checkout',
      repositories: [],
    }),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const service = new ProjectIterationsService(
    repository,
    access,
    projectContext,
  );
  return { service, repository, access, projectContext, iteration, state };
}
