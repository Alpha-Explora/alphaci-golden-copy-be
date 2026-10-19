// Side-effect module imported first by main.ts; see load-env.ts.
import { applyFileEnv } from '#kernel/config/file-env.js';
import { loadEnvFiles } from './load-env.js';

// Secrets mounted as files (X_FILE) become X before any .env file is read, so
// a value supplied through a secret file is never overridden by a stale .env.
applyFileEnv(process.env);
loadEnvFiles();
