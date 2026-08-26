export interface SessionUserContract {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  githubLogin: string | null;
  appRole: 'admin' | 'lead' | 'member';
}
