/**
 * One file in a generated scaffold.
 *
 * Declared here rather than in `scaffold.builder.ts` so a per-stack scaffold can
 * describe its output without importing the builder that calls it, which would
 * be a cycle. The builder re-exports it, so the public name is unchanged.
 */
export interface ScaffoldFile {
  path: string;
  content: string;
}
