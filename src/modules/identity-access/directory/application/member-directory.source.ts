import type {
  DirectoryCaller,
  DirectoryDescription,
  DirectoryRead,
} from '../domain/directory.types';

/**
 * Where a deployment's people come from. One implementation per kind of
 * directory, chosen by MEMBER_DIRECTORY_SOURCE in DirectoryModule. A new
 * directory (SSO/SCIM, an identity provider) is a new subclass, not a change
 * to the service or to any consumer.
 */
export abstract class MemberDirectorySource {
  abstract describe(): DirectoryDescription;

  abstract read(caller: DirectoryCaller): Promise<DirectoryRead>;
}
