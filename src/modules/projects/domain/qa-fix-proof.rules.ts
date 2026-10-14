/**
 * When proof of a fix may be attached to a Project run item (A2). Pure: the
 * service, the run payload and the repository's lock-time re-check all call
 * this one rule so they cannot disagree.
 *
 * Allowed while QA has returned the item to the developer, and after the
 * developer marked it Done (the item is back to `pending` with a fix request
 * recorded) and is waiting for re-test. Every other state refuses.
 */
export interface QaFixProofItemState {
  status: string;
  fix_requested_at: string | Date | null;
}

export function acceptsFixProof(item: QaFixProofItemState): boolean {
  if (item.status === 'returned_to_dev') {
    return true;
  }
  return item.status === 'pending' && item.fix_requested_at !== null;
}
