import * as asyncStorage from '#platform/server/asyncStorage';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import * as encryption from '#server/encryption';
import { PostError } from '#server/errors';
import { get, post } from '#server/post';
import { getServer, isValidBaseURL } from '#server/server-config';
import type {
  OpenIdConfig,
  PasskeyCeremonyOptions,
  PasskeyCeremonyResponse,
  PasskeyConfig,
  PasskeyCredentialSummary,
  PasskeyRegistrationSubject,
} from '#types/models';

export type AuthHandlers = {
  'get-did-bootstrap': typeof didBootstrap;
  'subscribe-needs-bootstrap': typeof needsBootstrap;
  'subscribe-bootstrap': typeof bootstrap;
  'subscribe-get-login-methods': typeof getLoginMethods;
  'subscribe-get-user': typeof getUser;
  'subscribe-change-password': typeof changePassword;
  'subscribe-sign-in': typeof signIn;
  'subscribe-sign-out': typeof signOut;
  'subscribe-set-token': typeof setToken;
  'enable-openid': typeof enableOpenId;
  'get-openid-config': typeof getOpenIdConfig;
  'enable-password': typeof enablePassword;
  'enable-passkey': typeof enablePasskey;
  'passkey-register-options': typeof passkeyRegisterOptions;
  'passkey-register-verify': typeof passkeyRegisterVerify;
  'passkey-login-options': typeof passkeyLoginOptions;
  'passkey-login-verify': typeof passkeyLoginVerify;
  'passkey-list': typeof passkeyList;
  'passkey-rename': typeof passkeyRename;
  'passkey-delete': typeof passkeyDelete;
  'passkey-invite': typeof passkeyInvite;
};

export const app = createApp<AuthHandlers>();
app.method('get-did-bootstrap', didBootstrap);
app.method('subscribe-needs-bootstrap', needsBootstrap);
app.method('subscribe-bootstrap', bootstrap);
app.method('subscribe-get-login-methods', getLoginMethods);
app.method('subscribe-get-user', getUser);
app.method('subscribe-change-password', changePassword);
app.method('subscribe-sign-in', signIn);
app.method('subscribe-sign-out', signOut);
app.method('subscribe-set-token', setToken);
app.method('enable-openid', enableOpenId);
app.method('get-openid-config', getOpenIdConfig);
app.method('enable-password', enablePassword);
app.method('enable-passkey', enablePasskey);
app.method('passkey-register-options', passkeyRegisterOptions);
app.method('passkey-register-verify', passkeyRegisterVerify);
app.method('passkey-login-options', passkeyLoginOptions);
app.method('passkey-login-verify', passkeyLoginVerify);
app.method('passkey-list', passkeyList);
app.method('passkey-rename', passkeyRename);
app.method('passkey-delete', passkeyDelete);
app.method('passkey-invite', passkeyInvite);

async function didBootstrap() {
  return Boolean(await asyncStorage.getItem('did-bootstrap'));
}

async function needsBootstrap({ url }: { url?: string } = {}) {
  if (url && !isValidBaseURL(url)) {
    return { error: 'get-server-failure' };
  }

  let serverConfig: ReturnType<typeof getServer>;

  try {
    serverConfig = getServer(url);
    if (!serverConfig) {
      return { bootstrapped: true, hasServer: false };
    }
  } catch {
    return { error: 'get-server-failure' };
  }

  let resText: string;
  try {
    resText = await get(serverConfig.SIGNUP_SERVER + '/needs-bootstrap');
  } catch {
    return { error: 'network-failure' };
  }

  let res: {
    status: 'ok';
    data: {
      bootstrapped: boolean;
      loginMethod: 'password' | 'openid' | string;
      availableLoginMethods: Array<{
        method: string;
        displayName: string;
        active: boolean;
      }>;
      multiuser: boolean;
    };
  };

  try {
    res = JSON.parse(resText);
  } catch {
    return { error: 'parse-failure' };
  }

  return {
    bootstrapped: res.data.bootstrapped,
    availableLoginMethods: res.data.availableLoginMethods || [
      { method: 'password', active: true, displayName: 'Password' },
    ],
    multiuser: res.data.multiuser || false,
    hasServer: true,
  };
}

async function bootstrap(loginConfig: {
  password?: string;
  openId?: OpenIdConfig;
}) {
  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    await post(serverConfig.SIGNUP_SERVER + '/bootstrap', loginConfig);
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
  return {};
}

async function getLoginMethods() {
  let res: {
    methods?: Array<{ method: string; displayName: string; active: boolean }>;
  };
  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    res = await fetch(serverConfig.SIGNUP_SERVER + '/login-methods').then(res =>
      res.json(),
    );
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  if (res.methods) {
    return { methods: res.methods };
  }
  return { error: 'internal' };
}

async function getUser() {
  const serverConfig = getServer();
  if (!serverConfig) {
    if (!(await asyncStorage.getItem('did-bootstrap'))) {
      return null;
    }
    return { offline: false };
  }

  const userToken = await asyncStorage.getItem('user-token');

  if (!userToken) {
    return null;
  }

  try {
    const res = await get(serverConfig.SIGNUP_SERVER + '/validate', {
      headers: {
        'X-ACTUAL-TOKEN': userToken,
      },
    });
    let tokenExpired = false;
    const {
      status,
      reason,
      data: {
        userName = null,
        permission = '',
        userId = null,
        displayName = null,
        loginMethod = null,
        prefs: serverPrefs,
      } = {},
    } = JSON.parse(res) || {};

    if (status === 'error') {
      if (reason === 'unauthorized') {
        return null;
      } else if (reason === 'token-expired') {
        tokenExpired = true;
      } else {
        return { offline: true };
      }
    }

    return {
      offline: false,
      userName,
      permission,
      userId,
      displayName,
      loginMethod,
      tokenExpired,
      serverPrefs,
    };
  } catch (e) {
    logger.log(e);
    return { offline: true };
  }
}

async function changePassword({ password }: { password: string }) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return { error: 'not-logged-in' };
  }

  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    await post(serverConfig.SIGNUP_SERVER + '/change-password', {
      token: userToken,
      password,
    });
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  return {};
}

async function signIn(
  loginInfo:
    | {
        password: string;
        loginMethod?: string;
      }
    | {
        returnUrl: string;
        loginMethod?: 'openid';
      },
) {
  if (
    typeof loginInfo.loginMethod !== 'string' ||
    loginInfo.loginMethod == null
  ) {
    loginInfo.loginMethod = 'password';
  }
  let res: {
    token?: string;
    returnUrl?: string;
  };

  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }
    res = await post(serverConfig.SIGNUP_SERVER + '/login', loginInfo);
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }

  if (res.returnUrl) {
    return { redirectUrl: res.returnUrl };
  }

  if (!res.token) {
    throw new Error('login: User token not set');
  }

  await asyncStorage.setItem('user-token', res.token);
  return {};
}

async function signOut() {
  encryption.unloadAllKeys();
  await asyncStorage.multiRemove([
    'user-token',
    'encrypt-keys',
    'lastBudget',
    'readOnly',
  ]);
  return 'ok';
}

async function setToken({ token }: { token: string }) {
  await asyncStorage.setItem('user-token', token);
}

async function enableOpenId(openIdConfig: { openId: OpenIdConfig }) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    if (!userToken) {
      return { error: 'unauthorized' };
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    await post(serverConfig.BASE_SERVER + '/openid/enable', openIdConfig, {
      'X-ACTUAL-TOKEN': userToken,
    });
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
  return {};
}

async function getOpenIdConfig({ password }: { password: string }) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    const res = await post(
      serverConfig.BASE_SERVER + '/openid/config',
      { password },
      {
        'X-ACTUAL-TOKEN': userToken,
      },
    );

    if (res) {
      return res as { openId: OpenIdConfig };
    }

    return null;
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
}

async function enablePassword(passwordConfig: {
  password: string;
  /** Which named-user method is being switched off. Defaults to OpenID. */
  from?: 'openid' | 'passkey';
}) {
  try {
    const userToken = await asyncStorage.getItem('user-token');

    if (!userToken) {
      return { error: 'unauthorized' };
    }

    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    const { from = 'openid', ...body } = passwordConfig;
    await post(serverConfig.BASE_SERVER + `/${from}/disable`, body, {
      'X-ACTUAL-TOKEN': userToken,
    });
  } catch (err) {
    if (err instanceof PostError) {
      return {
        error: err.reason || 'network-failure',
      };
    }

    throw err;
  }
  return {};
}

// ------------------------------------------------------------------ passkeys
//
// Every ceremony is two calls. The options call returns JSON that the UI hands
// to the browser's WebAuthn API, and the verify call returns the authenticator's
// answer to the server. The browser step cannot happen here: this code runs in
// a worker, which has no navigator.credentials, and WebAuthn needs a user
// gesture in the window anyway. So these handlers only move JSON.

type PasskeyError = { error: string };

async function passkeyPost<T>(
  path: string,
  body: unknown,
  { authenticated = false }: { authenticated?: boolean } = {},
): Promise<T | PasskeyError> {
  try {
    const serverConfig = getServer();
    if (!serverConfig) {
      throw new Error('No sync server configured.');
    }

    const headers: Record<string, string> = {};
    if (authenticated) {
      const userToken = await asyncStorage.getItem('user-token');
      if (!userToken) {
        return { error: 'unauthorized' };
      }
      headers['X-ACTUAL-TOKEN'] = userToken;
    }

    return (await post(
      serverConfig.BASE_SERVER + '/passkey' + path,
      body,
      headers,
    )) as T;
  } catch (err) {
    if (err instanceof PostError) {
      return { error: err.reason || 'network-failure' };
    }
    throw err;
  }
}

/** For the verbs `post()` does not cover. Same response envelope. */
async function passkeyRequest<T>(
  method: 'GET' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T | PasskeyError> {
  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('No sync server configured.');
  }

  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return { error: 'unauthorized' };
  }

  let json: { status: string; reason?: string; data?: T };
  try {
    const res = await fetch(serverConfig.BASE_SERVER + '/passkey' + path, {
      method,
      headers: {
        'X-ACTUAL-TOKEN': userToken,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    json = await res.json();
  } catch (err) {
    logger.log(err);
    return { error: 'network-failure' };
  }

  if (json.status !== 'ok') {
    return { error: json.reason ?? 'internal' };
  }
  return json.data as T;
}

async function enablePasskey(passkeyConfig: { passkey: PasskeyConfig }) {
  const result = await passkeyPost<Record<string, never>>(
    '/enable',
    passkeyConfig,
    { authenticated: true },
  );
  return 'error' in result ? { error: result.error } : {};
}

/**
 * Who is registering is decided by what `subject` carries: the server password
 * (the very first passkey, which creates the owner), an enrolment token (an
 * invited person), or nothing, meaning the signed-in user adding a device.
 */
async function passkeyRegisterOptions(subject: PasskeyRegistrationSubject) {
  const isSessionMode =
    !('password' in subject) && !('enrolmentToken' in subject);
  return passkeyPost<{ challengeId: string; options: PasskeyCeremonyOptions }>(
    '/register/options',
    subject,
    { authenticated: isSessionMode },
  );
}

async function passkeyRegisterVerify(
  input: PasskeyRegistrationSubject & {
    challengeId: string;
    response: PasskeyCeremonyResponse;
    name?: string;
  },
) {
  const isSessionMode = !('password' in input) && !('enrolmentToken' in input);
  const result = await passkeyPost<{
    token: string | null;
    credentialId: string;
  }>('/register/verify', input, { authenticated: isSessionMode });

  if ('error' in result) {
    return { error: result.error };
  }
  if (result.token) {
    await asyncStorage.setItem('user-token', result.token);
  }
  return { credentialId: result.credentialId };
}

async function passkeyLoginOptions() {
  return passkeyPost<{ challengeId: string; options: PasskeyCeremonyOptions }>(
    '/login/options',
    {},
  );
}

async function passkeyLoginVerify(input: {
  challengeId: string;
  response: PasskeyCeremonyResponse;
}) {
  const result = await passkeyPost<{ token: string }>('/login/verify', input);
  if ('error' in result) {
    return { error: result.error };
  }
  if (!result.token) {
    throw new Error('login: User token not set');
  }
  await asyncStorage.setItem('user-token', result.token);
  return {};
}

async function passkeyList({ userId }: { userId?: string } = {}) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const result = await passkeyRequest<PasskeyCredentialSummary[]>(
    'GET',
    `/credentials${query}`,
  );
  return 'error' in result ? result : { credentials: result };
}

async function passkeyRename({
  credentialId,
  name,
}: {
  credentialId: string;
  name: string;
}) {
  const result = await passkeyRequest<Record<string, never>>(
    'PATCH',
    `/credentials/${encodeURIComponent(credentialId)}`,
    { name },
  );
  return 'error' in result ? { error: result.error } : {};
}

async function passkeyDelete({ credentialId }: { credentialId: string }) {
  const result = await passkeyRequest<Record<string, never>>(
    'DELETE',
    `/credentials/${encodeURIComponent(credentialId)}`,
  );
  return 'error' in result ? { error: result.error } : {};
}

async function passkeyInvite({ userId }: { userId: string }) {
  return passkeyPost<{ token: string; expiresAt: number; url: string | null }>(
    '/invite',
    { userId },
    { authenticated: true },
  );
}
