import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type * as SimpleWebAuthn from '@simplewebauthn/server';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAccountDb } from './account-db';
import {
  androidOriginsFromConfig,
  bootstrapPasskey,
  getAssetLinks,
} from './accounts/passkey';
import { bootstrapPassword } from './accounts/password';
import { authRateLimiter } from './app-account';
import { handlers as app } from './app-passkey';
import { config } from './load-config';

// The ceremony verifiers need a real authenticator to produce input for.
// Everything around them (challenges, users, credentials, sessions, tokens)
// runs against the real database.
vi.mock('@simplewebauthn/server', async importOriginal => {
  const actual = await importOriginal<typeof SimpleWebAuthn>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

const mockedVerifyRegistration = vi.mocked(verifyRegistrationResponse);
const mockedVerifyAuthentication = vi.mocked(verifyAuthenticationResponse);

const SERVER = 'https://budget.example.com';
const SERVER_PASSWORD = 'server-pass';
const ADMIN_TOKEN = 'valid-token';
const USER_TOKEN = 'valid-token-user';
const NEVER_EXPIRES = -1;

const db = () => getAccountDb();

function registrationVerified(credentialId: string) {
  return {
    verified: true,
    registrationInfo: {
      fmt: 'none',
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialType: 'public-key',
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: SERVER,
      rpID: 'budget.example.com',
    },
  } as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>;
}

function authenticationVerified(credentialId: string, newCounter: number) {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: credentialId,
      newCounter,
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: SERVER,
      rpID: 'budget.example.com',
    },
  } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
}

function fakeResponse(id: string) {
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
  };
}

function clearNamedUsers() {
  db().mutate(
    "DELETE FROM user_access WHERE user_id IN (SELECT id FROM users WHERE user_name <> '')",
  );
  db().mutate("DELETE FROM users WHERE user_name <> ''");
}

/** The global setup's users and sessions, which other test files rely on. */
function restoreFixtures() {
  const insertUser = (
    id: string,
    name: string,
    role: string,
    owner: number,
  ) => {
    const existing = db().first('SELECT id FROM users WHERE id = ?', [id]);
    if (!existing) {
      db().mutate(
        'INSERT INTO users (id, user_name, display_name, enabled, owner, role) VALUES (?, ?, ?, 1, ?, ?)',
        [id, name, name, owner, role],
      );
    }
  };
  insertUser('genericAdmin', 'admin', 'ADMIN', 1);
  insertUser('genericUser', 'user', 'BASIC', 0);

  const insertSession = (token: string, userId: string) => {
    db().mutate('DELETE FROM sessions WHERE token = ?', [token]);
    db().mutate(
      'INSERT INTO sessions (token, expires_at, user_id) VALUES (?, ?, ?)',
      [token, NEVER_EXPIRES, userId],
    );
  };
  insertSession(ADMIN_TOKEN, 'genericAdmin');
  insertSession('valid-token-admin', 'genericAdmin');
  insertSession(USER_TOKEN, 'genericUser');
}

function insertCredential(id: string, userId: string, name = 'Phone') {
  db().mutate(
    `INSERT INTO passkey_credentials
       (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
     VALUES (?, ?, ?, 0, NULL, 'multiDevice', 1, ?, ?)`,
    [id, userId, Buffer.from([9, 9, 9]), name, Date.now()],
  );
}

function getCredential(id: string) {
  const row = db().first('SELECT * FROM passkey_credentials WHERE id = ?', [
    id,
  ]) as {
    user_id: string;
    counter: number;
    last_used_at: number | null;
    name: string | null;
  } | null;
  return row ?? undefined;
}

beforeEach(async () => {
  // Reset rather than clear: a queued once-value left behind by a request that
  // failed before reaching the verifier must not leak into the next test.
  mockedVerifyRegistration.mockReset();
  mockedVerifyAuthentication.mockReset();
  authRateLimiter.resetKey('127.0.0.1');
  authRateLimiter.resetKey('::ffff:127.0.0.1');

  db().mutate('DELETE FROM passkey_credentials');
  db().mutate('DELETE FROM pending_passkey_challenges');
  db().mutate('DELETE FROM passkey_enrolment_tokens');
  db().mutate("DELETE FROM sessions WHERE auth_method = 'passkey'");
  db().mutate('DELETE FROM auth');

  await bootstrapPassword(SERVER_PASSWORD);
  await bootstrapPasskey({ server_hostname: SERVER });
  restoreFixtures();
});

afterEach(() => {
  db().mutate('DELETE FROM files WHERE id LIKE ?', ['passkey-test-%']);
  restoreFixtures();
});

describe('bootstrapPasskey', () => {
  it('derives the relying party from the server hostname', async () => {
    const row = db().first(
      "SELECT extra_data, active FROM auth WHERE method = 'passkey'",
    ) as { extra_data: string; active: number };
    expect(row.active).toBe(1);
    expect(JSON.parse(row.extra_data)).toEqual({
      server_hostname: SERVER,
      rpName: 'Actual Budget',
      rpId: 'budget.example.com',
      origins: [SERVER],
    });
  });

  it('refuses a plain http hostname', async () => {
    expect(
      await bootstrapPasskey({ server_hostname: 'http://budget.example.com' }),
    ).toEqual({ error: 'server-hostname-not-https' });
  });

  it('allows localhost over http and keeps extra origins', async () => {
    expect(
      await bootstrapPasskey({
        server_hostname: 'http://localhost:5006',
        extraOrigins: ['android:apk-key-hash:abc', ' '],
      }),
    ).toEqual({});
    const row = db().first(
      "SELECT extra_data FROM auth WHERE method = 'passkey'",
    ) as { extra_data: string };
    expect(JSON.parse(row.extra_data).origins).toEqual([
      'http://localhost:5006',
      'android:apk-key-hash:abc',
    ]);
  });
});

describe('first registration (bootstrap)', () => {
  beforeEach(() => {
    clearNamedUsers();
  });

  it('demands the server password', async () => {
    const res = await request(app)
      .post('/register/options')
      .send({ password: 'wrong', userName: 'Luke' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ status: 'error', reason: 'invalid-password' });
  });

  it('issues discoverable-credential options and stores the challenge', async () => {
    const res = await request(app).post('/register/options').send({
      password: SERVER_PASSWORD,
      userName: 'Luke',
      displayName: 'Luke H',
    });

    expect(res.statusCode).toBe(200);
    const { challengeId, options } = res.body.data;
    expect(options.rp).toEqual({
      id: 'budget.example.com',
      name: 'Actual Budget',
    });
    expect(options.user.name).toBe('Luke');
    expect(options.user.displayName).toBe('Luke H');
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');

    const stored = db().first(
      'SELECT * FROM pending_passkey_challenges WHERE id = ?',
      [challengeId],
    ) as { challenge: string; kind: string; user_name: string };
    expect(stored.challenge).toBe(options.challenge);
    expect(stored.kind).toBe('registration');
    expect(stored.user_name).toBe('Luke');
  });

  it('creates the owner, stores the credential and signs them in', async () => {
    const passwordUser = db().first(
      "SELECT id FROM users WHERE user_name = ''",
    ) as { id: string };
    db().mutate('INSERT INTO files (id, name, owner) VALUES (?, ?, ?)', [
      'passkey-test-file',
      'Budget',
      passwordUser.id,
    ]);

    const options = await request(app)
      .post('/register/options')
      .send({ password: SERVER_PASSWORD, userName: 'Luke' });
    const { challengeId } = options.body.data;

    mockedVerifyRegistration.mockResolvedValueOnce(
      registrationVerified('cred-owner'),
    );

    const res = await request(app)
      .post('/register/verify')
      .send({
        password: SERVER_PASSWORD,
        userName: 'Luke',
        challengeId,
        response: fakeResponse('cred-owner'),
        name: 'Pixel',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.credentialId).toBe('cred-owner');
    expect(typeof res.body.data.token).toBe('string');

    expect(mockedVerifyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRPID: 'budget.example.com',
        expectedOrigin: [SERVER],
        requireUserVerification: true,
      }),
    );

    const owner = db().first(
      "SELECT * FROM users WHERE user_name = 'Luke'",
    ) as { id: string; owner: number; role: string };
    expect(owner.owner).toBe(1);
    expect(owner.role).toBe('ADMIN');

    const credential = getCredential('cred-owner');
    expect(credential?.user_id).toBe(owner.id);
    expect(credential?.name).toBe('Pixel');

    const session = db().first('SELECT * FROM sessions WHERE token = ?', [
      res.body.data.token,
    ]) as { user_id: string; auth_method: string; expires_at: number };
    expect(session.user_id).toBe(owner.id);
    expect(session.auth_method).toBe('passkey');
    expect(session.expires_at).toBe(NEVER_EXPIRES);

    const file = db().first('SELECT owner FROM files WHERE id = ?', [
      'passkey-test-file',
    ]) as { owner: string };
    expect(file.owner).toBe(owner.id);
  });

  it('spends the challenge on first use', async () => {
    const options = await request(app)
      .post('/register/options')
      .send({ password: SERVER_PASSWORD, userName: 'Luke' });
    const { challengeId } = options.body.data;

    mockedVerifyRegistration.mockResolvedValue(registrationVerified('cred-1'));

    const first = await request(app)
      .post('/register/verify')
      .send({
        password: SERVER_PASSWORD,
        userName: 'Luke',
        challengeId,
        response: fakeResponse('cred-1'),
      });
    expect(first.statusCode).toBe(200);

    // The challenge is consumed before any other check runs, so the replay is
    // refused even though the owner it would create now exists.
    const replay = await request(app)
      .post('/register/verify')
      .send({
        password: SERVER_PASSWORD,
        userName: 'Luke',
        challengeId,
        response: fakeResponse('cred-1'),
      });
    expect(replay.statusCode).toBe(400);
    expect(replay.body.reason).toBe('invalid-or-expired-challenge');
  });

  it('refuses once an owner exists', async () => {
    restoreFixtures();
    const res = await request(app)
      .post('/register/options')
      .send({ password: SERVER_PASSWORD, userName: 'Luke' });
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('already-bootstrapped');
  });
});

/** convict infers never[] from the empty default, so widen at the call site. */
function setFingerprints(values: string[]) {
  (config.set as (name: string, value: unknown) => void)(
    'passkey.androidCertFingerprints',
    values,
  );
}

describe('android app link', () => {
  const ORIGINAL_PACKAGE = config.get('passkey.androidPackage');
  const ORIGINAL_FINGERPRINTS = config.get('passkey.androidCertFingerprints');

  afterEach(() => {
    config.set('passkey.androidPackage', ORIGINAL_PACKAGE);
    setFingerprints(ORIGINAL_FINGERPRINTS as string[]);
  });

  it('publishes nothing until a package and a fingerprint are configured', () => {
    config.set('passkey.androidPackage', '');
    setFingerprints([]);
    expect(getAssetLinks()).toEqual([]);
    expect(androidOriginsFromConfig()).toEqual([]);

    // A package without a fingerprint would authorise nothing, so it is not
    // published either.
    config.set('passkey.androidPackage', 'org.actualbudget');
    expect(getAssetLinks()).toEqual([]);
  });

  it('publishes a statement Android can verify', () => {
    config.set('passkey.androidPackage', 'org.actualbudget');
    setFingerprints([
      '5D:8A:B2:8B:2D:9F:79:B5:F1:88:83:79:08:9E:D9:18:F9:A5:E7:48:F6:69:5B:EE:BC:D1:04:25:59:96:CB:89',
    ]);

    expect(getAssetLinks()).toEqual([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'org.actualbudget',
          sha256_cert_fingerprints: [
            '5D:8A:B2:8B:2D:9F:79:B5:F1:88:83:79:08:9E:D9:18:F9:A5:E7:48:F6:69:5B:EE:BC:D1:04:25:59:96:CB:89',
          ],
        },
      },
    ]);
  });

  it('accepts a fingerprint written without colons or in lower case', () => {
    config.set('passkey.androidPackage', 'org.actualbudget');
    setFingerprints([
      '5d8ab28b2d9f79b5f1888379089ed918f9a5e748f6695beebcd104255996cb89',
    ]);
    expect(
      (getAssetLinks()[0] as { target: { sha256_cert_fingerprints: string[] } })
        .target.sha256_cert_fingerprints[0],
    ).toBe(
      '5D:8A:B2:8B:2D:9F:79:B5:F1:88:83:79:08:9E:D9:18:F9:A5:E7:48:F6:69:5B:EE:BC:D1:04:25:59:96:CB:89',
    );
  });

  it('ignores a fingerprint that is not 32 bytes of hex', () => {
    config.set('passkey.androidPackage', 'org.actualbudget');
    setFingerprints(['not-a-fingerprint']);
    expect(getAssetLinks()).toEqual([]);
  });

  // The app presents the base64url of the raw digest, not the hex a person
  // reads off keytool, so the server converts rather than asking for both.
  it('derives the origin the app actually presents', () => {
    config.set('passkey.androidPackage', 'org.actualbudget');
    setFingerprints([
      '5D:8A:B2:8B:2D:9F:79:B5:F1:88:83:79:08:9E:D9:18:F9:A5:E7:48:F6:69:5B:EE:BC:D1:04:25:59:96:CB:89',
    ]);
    expect(androidOriginsFromConfig()).toEqual([
      'android:apk-key-hash:XYqyiy2febXxiIN5CJ7ZGPml50j2aVvuvNEEJVmWy4k',
    ]);
  });

  it('lets the app complete a ceremony, alongside the web origin', async () => {
    config.set('passkey.androidPackage', 'org.actualbudget');
    setFingerprints([
      '5D:8A:B2:8B:2D:9F:79:B5:F1:88:83:79:08:9E:D9:18:F9:A5:E7:48:F6:69:5B:EE:BC:D1:04:25:59:96:CB:89',
    ]);
    insertCredential('cred-android', 'genericUser');
    const { challengeId } = (await request(app).post('/login/options').send({}))
      .body.data;
    mockedVerifyAuthentication.mockResolvedValueOnce(
      authenticationVerified('cred-android', 1),
    );

    await request(app)
      .post('/login/verify')
      .send({ challengeId, response: fakeResponse('cred-android') });

    expect(mockedVerifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: [
          SERVER,
          'android:apk-key-hash:XYqyiy2febXxiIN5CJ7ZGPml50j2aVvuvNEEJVmWy4k',
        ],
      }),
    );
  });
});

describe('sign in', () => {
  it('issues options with no allowCredentials and required verification', async () => {
    const res = await request(app).post('/login/options').send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.options.allowCredentials).toEqual([]);
    expect(res.body.data.options.userVerification).toBe('required');
    expect(res.body.data.options.rpId).toBe('budget.example.com');
  });

  it('creates a session and advances the counter', async () => {
    insertCredential('cred-user', 'genericUser');
    const { challengeId } = (await request(app).post('/login/options').send({}))
      .body.data;

    mockedVerifyAuthentication.mockResolvedValueOnce(
      authenticationVerified('cred-user', 7),
    );

    const res = await request(app)
      .post('/login/verify')
      .send({ challengeId, response: fakeResponse('cred-user') });

    expect(res.statusCode).toBe(200);
    const session = db().first('SELECT * FROM sessions WHERE token = ?', [
      res.body.data.token,
    ]) as { user_id: string; auth_method: string };
    expect(session).toMatchObject({
      user_id: 'genericUser',
      auth_method: 'passkey',
    });

    const credential = getCredential('cred-user');
    expect(credential?.counter).toBe(7);
    expect(credential?.last_used_at).not.toBeNull();
  });

  it('rejects a credential it has never seen', async () => {
    const { challengeId } = (await request(app).post('/login/options').send({}))
      .body.data;
    const res = await request(app)
      .post('/login/verify')
      .send({ challengeId, response: fakeResponse('nope') });
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('unknown-credential');
    expect(mockedVerifyAuthentication).not.toHaveBeenCalled();
  });

  it('rejects a disabled user', async () => {
    insertCredential('cred-disabled', 'genericUser');
    db().mutate("UPDATE users SET enabled = 0 WHERE id = 'genericUser'");
    try {
      const { challengeId } = (
        await request(app).post('/login/options').send({})
      ).body.data;
      const res = await request(app)
        .post('/login/verify')
        .send({ challengeId, response: fakeResponse('cred-disabled') });
      expect(res.statusCode).toBe(400);
      expect(res.body.reason).toBe('user-not-found');
    } finally {
      db().mutate("UPDATE users SET enabled = 1 WHERE id = 'genericUser'");
    }
  });

  it('fails closed when verification fails', async () => {
    insertCredential('cred-user', 'genericUser');
    const { challengeId } = (await request(app).post('/login/options').send({}))
      .body.data;
    mockedVerifyAuthentication.mockResolvedValueOnce({
      verified: false,
    } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    const res = await request(app)
      .post('/login/verify')
      .send({ challengeId, response: fakeResponse('cred-user') });
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('authentication-failed');
    expect(getCredential('cred-user')?.counter).toBe(0);
  });
});

describe('invites and enrolment', () => {
  it('only admins can invite', async () => {
    const res = await request(app)
      .post('/invite')
      .set('x-actual-token', USER_TOKEN)
      .send({ userId: 'genericUser' });
    expect(res.statusCode).toBe(403);
  });

  it('enrols an invited user exactly once', async () => {
    const invite = await request(app)
      .post('/invite')
      .set('x-actual-token', ADMIN_TOKEN)
      .send({ userId: 'genericUser' });
    expect(invite.statusCode).toBe(200);
    const { token, url } = invite.body.data;
    expect(url).toBe(`${SERVER}/passkey-enroll?token=${token}`);

    const options = await request(app)
      .post('/register/options')
      .send({ enrolmentToken: token });
    expect(options.statusCode).toBe(200);
    expect(options.body.data.options.user.name).toBe('user');

    mockedVerifyRegistration.mockResolvedValueOnce(
      registrationVerified('cred-invited'),
    );
    const verify = await request(app)
      .post('/register/verify')
      .send({
        enrolmentToken: token,
        challengeId: options.body.data.challengeId,
        response: fakeResponse('cred-invited'),
      });
    expect(verify.statusCode).toBe(200);
    expect(getCredential('cred-invited')?.user_id).toBe('genericUser');
    expect(typeof verify.body.data.token).toBe('string');

    const reuse = await request(app)
      .post('/register/options')
      .send({ enrolmentToken: token });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.body.reason).toBe('enrolment-token-used');
  });

  it('rejects an expired invite', async () => {
    db().mutate(
      'INSERT INTO passkey_enrolment_tokens (token, user_id, expiry_time, used) VALUES (?, ?, ?, 0)',
      ['stale', 'genericUser', Date.now() - 1000],
    );
    const res = await request(app)
      .post('/register/options')
      .send({ enrolmentToken: 'stale' });
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('enrolment-token-expired');
  });

  it('lets a signed-in user add another device without a new session', async () => {
    insertCredential('cred-existing', 'genericUser');
    const options = await request(app)
      .post('/register/options')
      .set('x-actual-token', USER_TOKEN)
      .send({});
    expect(options.statusCode).toBe(200);
    expect(options.body.data.options.excludeCredentials).toEqual([
      expect.objectContaining({ id: 'cred-existing' }),
    ]);

    mockedVerifyRegistration.mockResolvedValueOnce(
      registrationVerified('cred-second'),
    );
    const verify = await request(app)
      .post('/register/verify')
      .set('x-actual-token', USER_TOKEN)
      .send({
        challengeId: options.body.data.challengeId,
        response: fakeResponse('cred-second'),
      });
    expect(verify.statusCode).toBe(200);
    expect(verify.body.data.token).toBeNull();
    expect(getCredential('cred-second')?.user_id).toBe('genericUser');
  });
});

describe('credential management', () => {
  it('lists only your own credentials unless you are an admin', async () => {
    insertCredential('cred-a', 'genericUser', 'Phone');
    insertCredential('cred-b', 'genericAdmin', 'Laptop');

    const own = await request(app)
      .get('/credentials')
      .set('x-actual-token', USER_TOKEN);
    expect(own.body.data.map((c: { id: string }) => c.id)).toEqual(['cred-a']);

    const denied = await request(app)
      .get('/credentials?userId=genericAdmin')
      .set('x-actual-token', USER_TOKEN);
    expect(denied.statusCode).toBe(403);

    const asAdmin = await request(app)
      .get('/credentials?userId=genericUser')
      .set('x-actual-token', ADMIN_TOKEN);
    expect(asAdmin.body.data).toEqual([
      expect.objectContaining({ id: 'cred-a', name: 'Phone', backedUp: true }),
    ]);
  });

  it('renames your own credential and refuses others', async () => {
    insertCredential('cred-a', 'genericUser');
    insertCredential('cred-b', 'genericAdmin');

    const ok = await request(app)
      .patch('/credentials/cred-a')
      .set('x-actual-token', USER_TOKEN)
      .send({ name: '  Work phone  ' });
    expect(ok.statusCode).toBe(200);
    expect(getCredential('cred-a')?.name).toBe('Work phone');

    const denied = await request(app)
      .patch('/credentials/cred-b')
      .set('x-actual-token', USER_TOKEN)
      .send({ name: 'Mine now' });
    expect(denied.statusCode).toBe(403);
  });

  it('will not let you delete your last credential while passkeys are active', async () => {
    insertCredential('cred-only', 'genericUser');
    const res = await request(app)
      .delete('/credentials/cred-only')
      .set('x-actual-token', USER_TOKEN);
    expect(res.statusCode).toBe(400);
    expect(res.body.reason).toBe('last-credential');
    expect(getCredential('cred-only')).toBeDefined();
  });

  it("lets an admin remove another person's last credential", async () => {
    insertCredential('cred-lost', 'genericUser');
    const res = await request(app)
      .delete('/credentials/cred-lost')
      .set('x-actual-token', ADMIN_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(getCredential('cred-lost')).toBeUndefined();
  });

  it('deletes one of several', async () => {
    insertCredential('cred-1', 'genericUser');
    insertCredential('cred-2', 'genericUser');
    const res = await request(app)
      .delete('/credentials/cred-1')
      .set('x-actual-token', USER_TOKEN);
    expect(res.statusCode).toBe(200);
    expect(getCredential('cred-1')).toBeUndefined();
    expect(getCredential('cred-2')).toBeDefined();
  });
});

describe('disable', () => {
  it('needs an admin and the server password', async () => {
    const asUser = await request(app)
      .post('/disable')
      .set('x-actual-token', USER_TOKEN)
      .send({ password: SERVER_PASSWORD });
    expect(asUser.statusCode).toBe(403);

    const wrong = await request(app)
      .post('/disable')
      .set('x-actual-token', ADMIN_TOKEN)
      .send({ password: 'wrong' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body.reason).toBe('invalid-password');
  });

  it('returns to password mode and removes named users and credentials', async () => {
    insertCredential('cred-a', 'genericUser');
    const res = await request(app)
      .post('/disable')
      .set('x-actual-token', ADMIN_TOKEN)
      .send({ password: SERVER_PASSWORD });
    expect(res.statusCode).toBe(200);

    expect(db().all("SELECT * FROM auth WHERE method = 'passkey'")).toEqual([]);
    expect(
      (
        db().first("SELECT active FROM auth WHERE method = 'password'") as {
          active: number;
        }
      ).active,
    ).toBe(1);
    expect(db().all("SELECT * FROM users WHERE user_name <> ''")).toEqual([]);
    expect(db().all('SELECT * FROM passkey_credentials')).toEqual([]);
  });
});
