import { ToolchainFragmentRegistry } from '#kernel/ports/toolchain-fragment.port';

import { dotnetToolchainFragment } from './dotnet-toolchain.fragment';
import { nodeToolchainFragments } from './node-toolchain.fragment';

export { dotnetToolchainFragment } from './dotnet-toolchain.fragment';
export { nodeToolchainFragments } from './node-toolchain.fragment';

/**
 * Every toolchain the generator can emit a quality stage for.
 *
 * Built eagerly at module load so a duplicate or empty stack key fails at
 * startup rather than on the first project generated. Adding a language is an
 * entry in this array plus its fragment file - see ADR-0006.
 */
export const defaultToolchainRegistry = new ToolchainFragmentRegistry([
  ...nodeToolchainFragments,
  dotnetToolchainFragment,
]);
