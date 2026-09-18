import type {
  EduAccount,
  EduRole,
  EduSignInAudience,
} from '../model/edu-auth.types.js';

export function normalizeEduEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEduStaffRole(role: EduRole): boolean {
  return role !== 'STUDENT';
}

export function expectedAudienceFor(role: EduRole): EduSignInAudience {
  return role === 'STUDENT' ? 'STUDENT' : 'STAFF';
}

export function isAllowedStudentEmail(
  email: string,
  allowedDomains: readonly string[],
): boolean {
  const normalized = normalizeEduEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  const domain = normalized.slice(at + 1);
  return allowedDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
  );
}

export function displayNameFromEduEmail(email: string): string {
  const localPart = normalizeEduEmail(email).split('@')[0] ?? email;
  return localPart
    .split(/[._-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

export function avatarColorForEduEmail(email: string): string {
  let hash = 0;
  for (const character of normalizeEduEmail(email)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const palette = ['#0e76a8', '#2f855a', '#805ad5', '#c05621', '#b83280'];
  return palette[hash % palette.length] ?? '#0e76a8';
}

export function accessibleLabSelectionIsValid(
  labs: readonly { id: string }[],
  selectedLabId: string | undefined,
): boolean {
  return (
    selectedLabId === undefined || labs.some((lab) => lab.id === selectedLabId)
  );
}

export function isAccountActive(account: EduAccount): boolean {
  return account.status === 'ACTIVE';
}
