/**
 * API-facing (camelCase) shapes for the QA checklists slice. These are the
 * exact contract the frontend is being built against — see the PR/task
 * description for the wire shape. Keep this file free of Nest/pg imports so
 * it stays a pure contract, importable from anywhere in the projects module.
 */

export type QaChecklistTargetPersona = 'developer' | 'qa' | 'all';

export type QaChecklistVerificationType =
  | 'manual'
  | 'playwright'
  | 'unit_test'
  | 'bruno';

export interface QaChecklistItem {
  id: string;
  position: number;
  title: string;
  description: string | null;
  targetPersona: QaChecklistTargetPersona;
  verificationType: QaChecklistVerificationType;
  testIdentifier: string | null;
}

/** Input shape for one item. `position` is implied by array index, not sent. */
export interface QaChecklistItemInput {
  title: string;
  description?: string | null;
  targetPersona: QaChecklistTargetPersona;
  verificationType: QaChecklistVerificationType;
  testIdentifier?: string | null;
}

export interface QaChecklist {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  version: number;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  items: QaChecklistItem[];
  sharedProjectIds: string[];
}

/** Max checklist items, enforced at the DTO layer and defensively in the service. */
export const QA_CHECKLIST_MAX_ITEMS = 200;
