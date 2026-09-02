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
