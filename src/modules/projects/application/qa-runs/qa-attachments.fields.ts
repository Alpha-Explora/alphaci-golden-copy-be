import { BadRequestException } from '@nestjs/common';

import { qaAttachmentKind } from '../qa-checklists/qa-errors';
import type { QaAttachmentSource } from './qa-runs.contracts';

export const QA_ATTACHMENT_CAPTION_MAX = 280;
export const QA_ATTACHMENT_MAX_PER_ITEM = 5;

/** What a person may say their screenshot came from; 'playwright' is the CI token's alone. */
const HUMAN_SOURCES: readonly QaAttachmentSource[] = [
  'capture',
  'paste',
  'upload',
];

/** The multipart text fields, validated. `kind` is a human kind: never 'automated'. */
export interface QaAttachmentUploadFields {
  kind: 'evidence' | 'fix_proof';
  source: 'capture' | 'paste' | 'upload';
  caption: string | null;
}

/** The uploaded file as multer's memory storage hands it over. */
export interface UploadedQaAttachmentFile {
  buffer: Buffer;
  size: number;
}

function text(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = body?.[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${key} must be a string.`);
  }
  return value;
}

/**
 * Validates the multipart text fields of POST .../attachments. Multipart
 * bodies are all strings and carry no class metadata, so this is explicit
 * rather than a DTO: it also lets `kind` answer its own coded 400.
 */
export function parseQaAttachmentFields(
  body: Record<string, unknown> | undefined,
): QaAttachmentUploadFields {
  const kind = text(body, 'kind') ?? 'evidence';
  if (kind !== 'evidence' && kind !== 'fix_proof') {
    throw qaAttachmentKind();
  }

  const source = text(body, 'source') ?? 'upload';
  if (!HUMAN_SOURCES.includes(source as QaAttachmentSource)) {
    throw new BadRequestException(
      'source must be one of capture, paste or upload.',
    );
  }

  const rawCaption = text(body, 'caption')?.trim();
  if (rawCaption && rawCaption.length > QA_ATTACHMENT_CAPTION_MAX) {
    throw new BadRequestException(
      `caption must be at most ${QA_ATTACHMENT_CAPTION_MAX} characters.`,
    );
  }

  return {
    kind,
    source: source as QaAttachmentUploadFields['source'],
    caption: rawCaption ? rawCaption : null,
  };
}
