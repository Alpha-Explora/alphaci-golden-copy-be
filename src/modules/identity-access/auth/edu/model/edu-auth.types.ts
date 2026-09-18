export type EduRole = 'STUDENT' | 'TEACHER' | 'ADMIN' | 'SUPER_ADMIN';

export type EduProfileStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export type EduSignInAudience = 'STUDENT' | 'STAFF';

export interface EduLab {
  id: string;
  name: string;
  githubOrgName: string;
}

export interface EduAccount {
  userId: string;
  email: string;
  fullName: string;
  role: EduRole;
  status: EduProfileStatus;
  homeLabId: string | null;
  githubUserId: string | null;
  githubLogin: string | null;
  githubAvatarUrl: string | null;
  githubProfileUrl: string | null;
  createdAt: string;
  supabaseUserId: string | null;
}

/**
 * The EDU API intentionally keeps the source application's response shape.
 * The frontend migration can therefore move its transport adapter without
 * changing the role, wrong-door, or lab-selection semantics.
 */
export interface EduSessionUser {
  id: string;
  fullName: string;
  email: string;
  role: EduRole;
  orgId: string | null;
  personalGithubUsername: string | null;
  status: EduProfileStatus;
  avatarColor: string;
  createdAt: string;
  githubUsername: string | null;
  consumesGithubSeat: boolean;
  githubLogin: string | null;
  githubAvatarUrl: string | null;
  githubProfileUrl: string | null;
  authUserId: string | null;
}

export interface EduLabsResponse {
  labs: EduLab[];
  selectedOrgId: string | null;
}

export type GithubConnectionState =
  | 'connected'
  | 'never_connected'
  | 'credential_missing'
  | 'revoked'
  | 'unconfigured'
  | 'check_failed'
  | 'not_applicable';

export interface GithubConnectionStatus {
  linked: boolean;
  login: string | null;
  connected: boolean;
  state: GithubConnectionState;
  scopes: string[];
  canCreateRepos: boolean;
  checkedAt: string;
}
