/**
 * The only identity the local Quick login flow may establish.
 *
 * This is deliberately not request-configurable. The synthetic provider id
 * cannot collide with a real GitHub numeric id and makes the local account
 * recognizable when inspecting a development database.
 */
export const DEV_QUICK_LOGIN_FIXTURE = {
  githubUserId: 'alphaci-local-dev-quick-login',
  login: 'alphaci-local-dev',
  name: 'AlphaCI Local Development User',
  email: 'alphaci-local-dev@example.invalid',
} as const;
