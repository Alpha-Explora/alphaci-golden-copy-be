/**
 * The member directory: the people a deployment's workspaces draw members
 * from. Which people that is depends on the deployment's source, not on the
 * edition or the client (ADR-0011).
 */

export type MemberDirectorySourceKind = 'github_org' | 'accounts';

/**
 * Who is reading the directory. A github_org source reads the roster with the
 * caller's own GitHub token, so the token travels with the caller.
 */
export interface DirectoryCaller {
  userId: string;
  githubToken: string | null;
}

/** Someone the source knows about, before matching to an AlphaCI account. */
export interface DirectoryPerson {
  login: string;
  avatarUrl: string | null;
}

/**
 * The outcome of reading a source. `unavailable` means the source could not
 * be read right now; it never means the directory is empty.
 */
export type DirectoryRead =
  | { kind: 'ok'; people: DirectoryPerson[] }
  | { kind: 'unavailable'; reason: string };

/** A person in the directory, matched against this deployment's accounts. */
export interface DirectoryEntry {
  /** AlphaCI account id. Null until the person signs in once. */
  id: string | null;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** True when the person has an active AlphaCI account and can be added. */
  hasAccount: boolean;
}

export interface DirectoryDescription {
  source: MemberDirectorySourceKind;
  /** The GitHub organization behind a github_org source, else null. */
  organization: string | null;
}

export interface DirectoryListing extends DirectoryDescription {
  members: DirectoryEntry[];
}

export interface DirectoryQuery {
  search?: string;
  limit?: number;
}
