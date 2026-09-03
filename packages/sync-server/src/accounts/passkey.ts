import { randomBytes } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { v4 as uuidv4 } from 'uuid';

import { clearExpiredSessions, getAccountDb } from '#account-db';
import { config } from '#load-config';
import { transferAllFilesFromUser } from '#services/user-service';
import { TOKEN_EXPIRATION_NEVER } from '#util/validate-user';

import { checkPassword } from './password';

// Passkeys as a login method.
//
// This mirrors the shape of the OpenID module: an `auth` row holds the
// relying-party configuration, short-lived rows hold ceremony state, and a
// successful ceremony ends in a row in `sessions`. Users are the same named
// users OpenID creates, so roles and file access carry over untouched.

export type PasskeyConfigParameter = {
  server_hostname?: string;
  rpName?: string;
  extraOrigins?: string[];
};

/**
 * A native Android app proves it may use this server's passkeys by hosting a
 * Digital Asset Links file here, and by presenting an origin derived from its
 * signing certificate. Both come from configuration; neither is inferred.
 */
export type AndroidAppLink = {
  packageName: string;
  /** Colon-separated uppercase hex, as `keytool` and Play Console print it. */
  certFingerprints: string[];
};

export type PasskeyConfig = {
  server_hostname: string;
  rpName: string;
  rpId: string;
  origins: string[];
};

type ErrorResult = { error: string };

type ChallengeRow = {
  id: string;
  challenge: string;
  kind: 'registration' | 'authentication';
  user_id: string | null;
  user_name: string | null;
  display_name: string | null;
  expiry_time: number;
};

type CredentialRow = {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
};

type UserRow = {
  id: string;
  user_name: string;
  display_name: string | null;
  enabled: number;
  owner: number;
  role: string;
};

type EnrolmentTokenRow = {
  token: string;
  user_id: string;
  expiry_time: number;
  used: number;
};

export type PasskeyCredentialSummary = {
  id: string;
  name: string | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

export type RegistrationRequest =
  | {
      mode: 'bootstrap';
      password: string;
      userName: string;
      displayName?: string;
    }
  | { mode: 'enrolment'; token: string }
  | { mode: 'session'; userId: string };

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ENROLMENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_ALGORITHMS = [-7, -257];

// ------------------------------------------------------------ configuration

export function deriveRelyingParty(
  serverHostname: string,
  extraOrigins: string[] = [],
): { rpId: string; origins: string[] } | ErrorResult {
  let url: URL;
  try {
    url = new URL(serverHostname);
  } catch {
    return { error: 'invalid-server-hostname' };
  }

  // WebAuthn only runs in a secure context. Refuse here, with a clear reason,
  // rather than letting every browser fail later with a generic error.
  const isLocalhost =
    url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !isLocalhost) {
    return { error: 'server-hostname-not-https' };
  }

  const origins = [url.origin];
  for (const extra of extraOrigins) {
    const trimmed = extra.trim();
    if (trimmed !== '' && !origins.includes(trimmed)) {
      origins.push(trimmed);
    }
  }

  return { rpId: url.hostname, origins };
}

export async function bootstrapPasskey(
  configParameter: PasskeyConfigParameter,
): Promise<ErrorResult | Record<string, never>> {
  const serverHostname = configParameter.server_hostname;
  if (!serverHostname) {
    return { error: 'missing-server-hostname' };
  }

  const relyingParty = deriveRelyingParty(
    serverHostname,
    configParameter.extraOrigins ?? [],
  );
  if ('error' in relyingParty) {
    return relyingParty;
  }

  const stored: PasskeyConfig = {
    server_hostname: serverHostname,
    rpName: configParameter.rpName?.trim() || 'Actual Budget',
    rpId: relyingParty.rpId,
    // The Android origin is added from config at verification time rather than
    // frozen here, so changing the app's signing key does not mean
    // reconfiguring passkeys.
    origins: relyingParty.origins,
  };

  const accountDb = getAccountDb();
  try {
    accountDb.transaction(() => {
      accountDb.mutate('DELETE FROM auth WHERE method = ?', ['passkey']);
      accountDb.mutate('UPDATE auth SET active = 0');
      accountDb.mutate(
        "INSERT INTO auth (method, display_name, extra_data, active) VALUES ('passkey', 'Passkey', ?, 1)",
        [JSON.stringify(stored)],
      );
    });
  } catch (err) {
    console.error('Error updating auth table:', err);
    return { error: 'database-error' };
  }

  return {};
}

export function getPasskeyConfig(): PasskeyConfig | null {
  const row = getAccountDb().first(
    'SELECT extra_data FROM auth WHERE method = ?',
    ['passkey'],
  ) as { extra_data: string } | undefined;

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.extra_data) as PasskeyConfig;
  } catch (err) {
    console.error('Error parsing passkey configuration:', err);
    return null;
  }
}

export function getPasskeyServerHostname(): string | null {
  return getPasskeyConfig()?.server_hostname ?? null;
}

// ----------------------------------------------------------- android app link

export function getAndroidAppLink(): AndroidAppLink | null {
  const packageName = (config.get('passkey.androidPackage') as string)?.trim();
  const fingerprints = (
    (config.get('passkey.androidCertFingerprints') as string[]) ?? []
  )
    .map(value => normaliseFingerprint(value))
    .filter((value): value is string => value !== null);

  if (!packageName || fingerprints.length === 0) {
    return null;
  }
  return { packageName, certFingerprints: fingerprints };
}

/**
 * The Digital Asset Links statement list. Android fetches this over https and
 * only then lets the named app act for this domain's credentials.
 */
export function getAssetLinks(): unknown[] {
  const appLink = getAndroidAppLink();
  if (!appLink) {
    return [];
  }
  return [
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: appLink.packageName,
        sha256_cert_fingerprints: appLink.certFingerprints,
      },
    },
  ];
}

/**
 * The origin a native Android app presents during a ceremony. It is the
 * base64url of the raw certificate digest, not the hex `keytool` prints, so
 * the two representations are converted here rather than asked of the user.
 */
export function androidOriginsFromConfig(): string[] {
  const appLink = getAndroidAppLink();
  if (!appLink) {
    return [];
  }
  return appLink.certFingerprints.map(fingerprint => {
    const bytes = Buffer.from(fingerprint.split(':').join(''), 'hex');
    return `android:apk-key-hash:${bytes.toString('base64url')}`;
  });
}

/**
 * Origins allowed to complete a ceremony: the web origins stored when passkeys
 * were configured, plus any native Android app currently named in config.
 */
function expectedOrigins(passkeyConfig: PasskeyConfig): string[] {
  return [...passkeyConfig.origins, ...androidOriginsFromConfig()];
}

/** Accepts hex with or without colons, in any case; rejects anything else. */
function normaliseFingerprint(value: string): string | null {
  const hex = value.trim().replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    if (value.trim() !== '') {
      console.error(
        'Ignoring an Android certificate fingerprint that is not 32 bytes of hex:',
        value,
      );
    }
    return null;
  }
  return (hex.match(/.{2}/g) ?? []).join(':');
}

/** Everything the passkey method owns, apart from the auth row itself. */
export function resetPasskeys(): void {
  const accountDb = getAccountDb();
  accountDb.mutate('DELETE FROM passkey_credentials');
  accountDb.mutate('DELETE FROM pending_passkey_challenges');
  accountDb.mutate('DELETE FROM passkey_enrolment_tokens');
}

// ------------------------------------------------------------- registration

export async function createRegistrationOptions(
  request: RegistrationRequest,
): Promise<
  | ErrorResult
  | { challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }
> {
  const passkeyConfig = getPasskeyConfig();
  if (!passkeyConfig) {
    return { error: 'passkey-not-configured' };
  }

  const subject = await resolveRegistrationSubject(request);
  if ('error' in subject) {
    return subject;
  }

  const existing = subject.isNewUser
    ? []
    : listCredentialRows(subject.userId).map(row => ({
        id: row.id,
        transports: parseTransports(row.transports),
      }));

  const options = await generateRegistrationOptions({
    rpName: passkeyConfig.rpName,
    rpID: passkeyConfig.rpId,
    userID: new TextEncoder().encode(subject.userId),
    userName: subject.userName,
    userDisplayName: subject.displayName ?? subject.userName,
    attestationType: 'none',
    excludeCredentials: existing,
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
  });

  const challengeId = storeChallenge({
    challenge: options.challenge,
    kind: 'registration',
    userId: subject.userId,
    userName: subject.isNewUser ? subject.userName : null,
    displayName: subject.isNewUser ? (subject.displayName ?? null) : null,
  });

  return { challengeId, options };
}

export async function verifyRegistration(input: {
  request: RegistrationRequest;
  challengeId: string;
  response: RegistrationResponseJSON;
  name?: string;
}): Promise<ErrorResult | { token: string | null; credentialId: string }> {
  const passkeyConfig = getPasskeyConfig();
  if (!passkeyConfig) {
    return { error: 'passkey-not-configured' };
  }

  const challenge = consumeChallenge(input.challengeId, 'registration');
  if (!challenge) {
    return { error: 'invalid-or-expired-challenge' };
  }

  // Re-check the gate that issued the challenge. Between options and verify
  // another request may have bootstrapped the server or spent the token. For
  // a bootstrap the user does not exist yet, so its identity is whatever the
  // challenge was minted for.
  const subject = await resolveRegistrationSubject(input.request, {
    userId: challenge.user_id,
    userName: challenge.user_name,
    displayName: challenge.display_name,
  });
  if ('error' in subject) {
    return subject;
  }
  if (subject.userId !== challenge.user_id) {
    return { error: 'challenge-subject-mismatch' };
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: expectedOrigins(passkeyConfig),
      expectedRPID: passkeyConfig.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    console.error('Passkey registration failed:', err);
    return { error: 'registration-failed' };
  }

  if (!verification.verified) {
    return { error: 'registration-failed' };
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const accountDb = getAccountDb();
  const now = Date.now();
  let token: string | null = null;

  try {
    accountDb.transaction(() => {
      if (subject.isNewUser) {
        accountDb.mutate(
          'INSERT INTO users (id, user_name, display_name, enabled, owner, role) VALUES (?, ?, ?, 1, 1, ?)',
          [
            subject.userId,
            subject.userName,
            subject.displayName ?? subject.userName,
            'ADMIN',
          ],
        );

        // The password-mode user (empty user name) owns every existing file.
        // Hand them to the new owner. Queried directly: getUserByUsername
        // treats the empty string as "no name given" and returns null.
        const passwordUser = accountDb.first(
          "SELECT id FROM users WHERE user_name = ''",
        ) as { id: string } | undefined;
        if (passwordUser) {
          transferAllFilesFromUser(subject.userId, passwordUser.id);
        }
      }

      if (input.request.mode === 'enrolment') {
        accountDb.mutate(
          'UPDATE passkey_enrolment_tokens SET used = 1 WHERE token = ?',
          [input.request.token],
        );
      }

      accountDb.mutate(
        `INSERT INTO passkey_credentials
           (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          credential.id,
          subject.userId,
          Buffer.from(credential.publicKey),
          credential.counter,
          credential.transports ? JSON.stringify(credential.transports) : null,
          credentialDeviceType,
          credentialBackedUp ? 1 : 0,
          normaliseName(input.name),
          now,
        ],
      );

      // Adding a device to an existing session should not mint a new session;
      // the caller already has one.
      if (input.request.mode !== 'session') {
        token = createSession(subject.userId);
      }
    });
  } catch (err) {
    console.error('Error storing passkey credential:', err);
    return { error: 'database-error' };
  }

  clearExpiredSessions();

  return { token, credentialId: credential.id };
}

type RegistrationSubject = {
  userId: string;
  userName: string;
  displayName: string | null;
  isNewUser: boolean;
};

type PendingIdentity = {
  userId: string | null;
  userName: string | null;
  displayName: string | null;
};

async function resolveRegistrationSubject(
  request: RegistrationRequest,
  pending?: PendingIdentity,
): Promise<ErrorResult | RegistrationSubject> {
  const accountDb = getAccountDb();

  switch (request.mode) {
    case 'bootstrap': {
      if (countNamedUsers() > 0) {
        return { error: 'already-bootstrapped' };
      }

      // The server password guards the very first enrolment, so nobody can
      // claim ownership of a freshly configured server.
      const passwordConfigured = accountDb.first(
        'SELECT method FROM auth WHERE method = ?',
        ['password'],
      );
      if (passwordConfigured && !(await checkPassword(request.password))) {
        return { error: 'invalid-password' };
      }

      // On verify, the identity is the one the challenge was minted for; the
      // user row does not exist until verification succeeds.
      if (pending) {
        if (!pending.userId || !pending.userName) {
          return { error: 'invalid-or-expired-challenge' };
        }
        return {
          userId: pending.userId,
          userName: pending.userName,
          displayName: pending.displayName,
          isNewUser: true,
        };
      }

      const userName = request.userName?.trim();
      if (!userName) {
        return { error: 'user-cant-be-empty' };
      }

      return {
        userId: uuidv4(),
        userName,
        displayName: request.displayName?.trim() || null,
        isNewUser: true,
      };
    }

    case 'enrolment': {
      const row = accountDb.first(
        'SELECT token, user_id, expiry_time, used FROM passkey_enrolment_tokens WHERE token = ?',
        [request.token],
      ) as EnrolmentTokenRow | undefined;

      if (!row) {
        return { error: 'invalid-enrolment-token' };
      }
      if (row.used) {
        return { error: 'enrolment-token-used' };
      }
      if (row.expiry_time <= Date.now()) {
        return { error: 'enrolment-token-expired' };
      }

      const user = getEnabledUser(row.user_id);
      if (!user) {
        return { error: 'user-not-found' };
      }

      return {
        userId: user.id,
        userName: user.user_name,
        displayName: user.display_name,
        isNewUser: false,
      };
    }

    case 'session': {
      const user = getEnabledUser(request.userId);
      if (!user) {
        return { error: 'user-not-found' };
      }
      return {
        userId: user.id,
        userName: user.user_name,
        displayName: user.display_name,
        isNewUser: false,
      };
    }

    default:
      return { error: 'invalid-request' };
  }
}

// ----------------------------------------------------------- authentication

export async function createAuthenticationOptions(): Promise<
  | ErrorResult
  | { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
> {
  const passkeyConfig = getPasskeyConfig();
  if (!passkeyConfig) {
    return { error: 'passkey-not-configured' };
  }

  // No allowCredentials: the authenticator presents its own account picker
  // from the discoverable credentials it holds for this relying party.
  const options = await generateAuthenticationOptions({
    rpID: passkeyConfig.rpId,
    allowCredentials: [],
    userVerification: 'required',
  });

  const challengeId = storeChallenge({
    challenge: options.challenge,
    kind: 'authentication',
    userId: null,
    userName: null,
    displayName: null,
  });

  return { challengeId, options };
}

export async function verifyAuthentication(input: {
  challengeId: string;
  response: AuthenticationResponseJSON;
}): Promise<ErrorResult | { token: string }> {
  const passkeyConfig = getPasskeyConfig();
  if (!passkeyConfig) {
    return { error: 'passkey-not-configured' };
  }

  const challenge = consumeChallenge(input.challengeId, 'authentication');
  if (!challenge) {
    return { error: 'invalid-or-expired-challenge' };
  }

  const accountDb = getAccountDb();
  const credential = accountDb.first(
    'SELECT * FROM passkey_credentials WHERE id = ?',
    [input.response.id],
  ) as CredentialRow | undefined;

  if (!credential) {
    return { error: 'unknown-credential' };
  }

  const user = getEnabledUser(credential.user_id);
  if (!user) {
    return { error: 'user-not-found' };
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: expectedOrigins(passkeyConfig),
      expectedRPID: passkeyConfig.rpId,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: parseTransports(credential.transports),
      },
    });
  } catch (err) {
    console.error('Passkey authentication failed:', err);
    return { error: 'authentication-failed' };
  }

  if (!verification.verified) {
    return { error: 'authentication-failed' };
  }

  accountDb.mutate(
    'UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?',
    [verification.authenticationInfo.newCounter, Date.now(), credential.id],
  );

  const token = createSession(user.id);
  clearExpiredSessions();

  return { token };
}

// --------------------------------------------------------------- enrolment

export function createEnrolmentToken(
  userId: string,
): ErrorResult | { token: string; expiresAt: number } {
  const user = getEnabledUser(userId);
  if (!user) {
    return { error: 'user-not-found' };
  }

  const accountDb = getAccountDb();
  const now = Date.now();
  accountDb.mutate(
    'DELETE FROM passkey_enrolment_tokens WHERE expiry_time < ? OR used = 1',
    [now],
  );

  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + ENROLMENT_TOKEN_TTL_MS;
  accountDb.mutate(
    'INSERT INTO passkey_enrolment_tokens (token, user_id, expiry_time, used) VALUES (?, ?, ?, 0)',
    [token, userId, expiresAt],
  );

  return { token, expiresAt };
}

// -------------------------------------------------------------- management

export function listCredentials(userId: string): PasskeyCredentialSummary[] {
  return listCredentialRows(userId).map(row => ({
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export function renameCredential(input: {
  credentialId: string;
  name: string;
  requesterId: string;
  isAdmin: boolean;
}): ErrorResult | Record<string, never> {
  const credential = getCredentialForRequester(input);
  if ('error' in credential) {
    return credential;
  }

  getAccountDb().mutate(
    'UPDATE passkey_credentials SET name = ? WHERE id = ?',
    [normaliseName(input.name), credential.id],
  );
  return {};
}

export function deleteCredential(input: {
  credentialId: string;
  requesterId: string;
  isAdmin: boolean;
}): ErrorResult | Record<string, never> {
  const credential = getCredentialForRequester(input);
  if ('error' in credential) {
    return credential;
  }

  // Removing your own last passkey while passkeys are the active method would
  // lock you out. An admin may still remove another person's last one, so a
  // lost phone can be replaced by a fresh enrolment link.
  const remaining = listCredentialRows(credential.user_id).length;
  const isOwnLast = remaining <= 1 && credential.user_id === input.requesterId;
  if (isOwnLast && getActiveMethod() === 'passkey') {
    return { error: 'last-credential' };
  }

  getAccountDb().mutate('DELETE FROM passkey_credentials WHERE id = ?', [
    credential.id,
  ]);
  return {};
}

function getCredentialForRequester(input: {
  credentialId: string;
  requesterId: string;
  isAdmin: boolean;
}): ErrorResult | CredentialRow {
  const credential = getAccountDb().first(
    'SELECT * FROM passkey_credentials WHERE id = ?',
    [input.credentialId],
  ) as CredentialRow | undefined;

  if (!credential) {
    return { error: 'unknown-credential' };
  }
  if (credential.user_id !== input.requesterId && !input.isAdmin) {
    return { error: 'forbidden' };
  }
  return credential;
}

// ----------------------------------------------------------------- helpers

function storeChallenge(input: {
  challenge: string;
  kind: ChallengeRow['kind'];
  userId: string | null;
  userName: string | null;
  displayName: string | null;
}): string {
  const accountDb = getAccountDb();
  const now = Date.now();

  accountDb.mutate(
    'DELETE FROM pending_passkey_challenges WHERE expiry_time < ?',
    [now],
  );

  const id = uuidv4();
  accountDb.mutate(
    'INSERT INTO pending_passkey_challenges (id, challenge, kind, user_id, user_name, display_name, expiry_time) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.challenge,
      input.kind,
      input.userId,
      input.userName,
      input.displayName,
      now + CHALLENGE_TTL_MS,
    ],
  );
  return id;
}

/** A challenge is spent on first use, whether or not verification succeeds. */
function consumeChallenge(
  challengeId: string,
  kind: ChallengeRow['kind'],
): ChallengeRow | null {
  const accountDb = getAccountDb();
  let row: ChallengeRow | undefined;

  accountDb.transaction(() => {
    row = accountDb.first(
      'SELECT * FROM pending_passkey_challenges WHERE id = ?',
      [challengeId],
    ) as ChallengeRow | undefined;
    if (row) {
      accountDb.mutate('DELETE FROM pending_passkey_challenges WHERE id = ?', [
        challengeId,
      ]);
    }
  });

  if (!row || row.kind !== kind || row.expiry_time <= Date.now()) {
    return null;
  }
  return row;
}

function createSession(userId: string): string {
  const token = uuidv4();
  getAccountDb().mutate(
    'INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES (?, ?, ?, ?)',
    [token, sessionExpiry(), userId, 'passkey'],
  );
  return token;
}

function sessionExpiry(): number {
  const setting = config.get('token_expiration');
  if (typeof setting === 'number') {
    return Math.floor(Date.now() / 1000) + setting;
  }
  return TOKEN_EXPIRATION_NEVER;
}

function countNamedUsers(): number {
  const row = getAccountDb().first(
    "SELECT count(*) as count FROM users WHERE user_name <> ''",
  ) as { count: number };
  return row.count;
}

function getEnabledUser(userId: string): UserRow | null {
  const row = getAccountDb().first(
    'SELECT * FROM users WHERE id = ? AND enabled = 1',
    [userId],
  ) as UserRow | undefined;
  return row ?? null;
}

function getActiveMethod(): string | null {
  const row = getAccountDb().first(
    'SELECT method FROM auth WHERE active = 1',
  ) as { method: string } | undefined;
  return row?.method ?? null;
}

function listCredentialRows(userId: string): CredentialRow[] {
  return getAccountDb().all(
    'SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at',
    [userId],
  ) as CredentialRow[];
}

function parseTransports(
  stored: string | null,
): AuthenticatorTransportFuture[] | undefined {
  if (!stored) {
    return undefined;
  }
  try {
    return JSON.parse(stored) as AuthenticatorTransportFuture[];
  } catch {
    return undefined;
  }
}

function normaliseName(name: string | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}
