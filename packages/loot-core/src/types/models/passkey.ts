export type PasskeyConfig = {
  server_hostname: string;
  rpName?: string;
  extraOrigins?: string[];
};

/**
 * WebAuthn ceremony JSON, as produced and consumed by the sync server.
 * The shapes are the W3C `*JSON` dictionaries; the client hands them to the
 * browser's WebAuthn helper untouched, so they are kept opaque here rather
 * than duplicating the spec's types.
 */
export type PasskeyCeremonyOptions = {
  challenge: string;
  [key: string]: unknown;
};

export type PasskeyCeremonyResponse = {
  id: string;
  rawId: string;
  type: string;
  response: unknown;
  clientExtensionResults: unknown;
  authenticatorAttachment?: string;
};

export type PasskeyCredentialSummary = {
  id: string;
  name: string | null;
  deviceType: 'singleDevice' | 'multiDevice' | null;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

export type PasskeyRegistrationSubject =
  | { password: string; userName: string; displayName?: string }
  | { enrolmentToken: string }
  /** Neither: a signed-in user adding a device to their own account. */
  | { password?: undefined; enrolmentToken?: undefined };
