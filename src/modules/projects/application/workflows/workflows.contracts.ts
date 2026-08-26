import type {
  WorkflowHistoryEntry,
  WorkflowHistoryRepository,
} from './infrastructure/workflow-history.repository';

export interface WorkflowHistoryQuery {
  listForProjectIdentity(input: {
    userId: string;
    serviceName: string;
    templateId: string | null;
    limit?: number;
  }): ReturnType<WorkflowHistoryRepository['listForProjectIdentity']>;
}

export const WORKFLOW_HISTORY_QUERY = Symbol('WORKFLOW_HISTORY_QUERY');

export type { WorkflowHistoryEntry };
