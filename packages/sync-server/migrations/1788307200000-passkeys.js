import { getAccountDb } from '../src/account-db';

export const up = async function () {
  await getAccountDb().exec(
    `
    BEGIN TRANSACTION;

    CREATE TABLE passkey_credentials
      (id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id));

    CREATE INDEX passkey_credentials_user_id ON passkey_credentials(user_id);

    CREATE TABLE pending_passkey_challenges
      (id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      display_name TEXT,
      expiry_time INTEGER NOT NULL);

    CREATE TABLE passkey_enrolment_tokens
      (token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expiry_time INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id));

    COMMIT;`,
  );
};

export const down = async function () {
  await getAccountDb().exec(
    `
    BEGIN TRANSACTION;
    DROP TABLE IF EXISTS passkey_enrolment_tokens;
    DROP TABLE IF EXISTS pending_passkey_challenges;
    DROP TABLE IF EXISTS passkey_credentials;
    COMMIT;`,
  );
};
