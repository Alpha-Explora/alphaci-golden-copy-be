/**
 * Shell arguments for an `npm install` that runs without a lockfile.
 *
 * A generated project ships no package-lock.json, so its first installs
 * resolve every range to the newest version. A version published minutes
 * before the run can still be missing from the registry's download CDN, and
 * the install fails with a 404 (napi-postinstall 0.3.5 broke a fresh project
 * this way). `--before` resolves as of one day ago instead: a new project's
 * first pipelines stay green, and a version only installs once it has been
 * public for a day. Installs from a lockfile are exact and do not use this.
 *
 * Evaluated by the shell at install time; needs only `node` on the PATH, which
 * every Node image and setup-node job has.
 */
export const NPM_INSTALL_COOLDOWN =
  '--before="$(node -p \'new Date(Date.now() - 864e5).toISOString()\')"';
