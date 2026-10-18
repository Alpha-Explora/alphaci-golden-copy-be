import { applyFileEnv, FILE_ENV_ALLOW_LIST } from './file-env';

function reader(files: Record<string, string>) {
  return (path: string): string => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

describe('applyFileEnv', () => {
  it('copies the trimmed file contents into the plain variable', () => {
    const env: NodeJS.ProcessEnv = {
      SESSION_SECRET_FILE: '/run/secrets/session_secret',
    };

    applyFileEnv(
      env,
      FILE_ENV_ALLOW_LIST,
      reader({ '/run/secrets/session_secret': 'abc123\n' }),
    );

    expect(env['SESSION_SECRET']).toBe('abc123');
  });

  it('keeps the internal newlines of a PEM private key', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIBcd\nefGH\n-----END PRIVATE KEY-----\n';
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github_app_private_key',
    };

    applyFileEnv(
      env,
      FILE_ENV_ALLOW_LIST,
      reader({ '/run/secrets/github_app_private_key': pem }),
    );

    expect(env['GITHUB_APP_PRIVATE_KEY']).toBe(pem.trim());
  });

  it('leaves variables without a _FILE companion untouched', () => {
    const env: NodeJS.ProcessEnv = { SESSION_SECRET: 'already-set-value' };

    applyFileEnv(env, FILE_ENV_ALLOW_LIST, reader({}));

    expect(env['SESSION_SECRET']).toBe('already-set-value');
    expect(env['DATABASE_URL']).toBeUndefined();
  });

  it('ignores a blank _FILE value', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL_FILE: '   ' };

    applyFileEnv(env, FILE_ENV_ALLOW_LIST, reader({}));

    expect(env['DATABASE_URL']).toBeUndefined();
  });

  it('refuses to choose when both the value and the _FILE companion are set', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://a',
      DATABASE_URL_FILE: '/run/secrets/database_url',
    };

    expect(() =>
      applyFileEnv(
        env,
        FILE_ENV_ALLOW_LIST,
        reader({ '/run/secrets/database_url': 'postgres://b' }),
      ),
    ).toThrow(/DATABASE_URL and DATABASE_URL_FILE are both set/);
    expect(env['DATABASE_URL']).toBe('postgres://a');
  });

  it('names the variable and path, not the contents, when the file is missing', () => {
    const env: NodeJS.ProcessEnv = {
      SESSION_SECRET_FILE: '/run/secrets/missing',
    };

    let message = '';
    try {
      applyFileEnv(env, FILE_ENV_ALLOW_LIST, reader({}));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('SESSION_SECRET_FILE');
    expect(message).toContain('/run/secrets/missing');
    expect(env['SESSION_SECRET']).toBeUndefined();
  });

  it('refuses an empty secret file', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_CLIENT_SECRET_FILE: '/run/secrets/oauth',
    };

    expect(() =>
      applyFileEnv(
        env,
        FILE_ENV_ALLOW_LIST,
        reader({ '/run/secrets/oauth': ' \n' }),
      ),
    ).toThrow(/empty file/);
  });

  it('only maps keys on the allow-list', () => {
    const env: NodeJS.ProcessEnv = {
      SOMETHING_ELSE_FILE: '/run/secrets/other',
    };

    applyFileEnv(
      env,
      FILE_ENV_ALLOW_LIST,
      reader({ '/run/secrets/other': 'value' }),
    );

    expect(env['SOMETHING_ELSE']).toBeUndefined();
  });

  it('honours a caller-supplied allow-list', () => {
    const env: NodeJS.ProcessEnv = {
      CUSTOM_FILE: '/run/secrets/custom',
      SESSION_SECRET_FILE: '/run/secrets/session',
    };

    applyFileEnv(env, ['CUSTOM'], reader({ '/run/secrets/custom': 'x' }));

    expect(env['CUSTOM']).toBe('x');
    expect(env['SESSION_SECRET']).toBeUndefined();
  });
});
