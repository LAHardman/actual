import type {
  PasskeyCeremonyOptions,
  PasskeyCeremonyResponse,
} from '@actual-app/core/types/models';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

import { hasPasskeyBridge, runBridgeCeremony } from './passkey-bridge';

// The browser half of a passkey ceremony. loot-core runs in a worker and only
// relays JSON; the WebAuthn call itself has to happen here, in the window,
// in response to a click.
//
// Actual's Android shell embeds a browser engine that Android will not let
// call WebAuthn for a website, so it offers a native bridge instead. Where one
// is present it is used, because navigator.credentials would simply fail.

export function passkeysSupported(): boolean {
  return hasPasskeyBridge() || browserSupportsWebAuthn();
}

export async function createPasskey(
  options: PasskeyCeremonyOptions,
): Promise<
  | { response: RegistrationResponseJSON | PasskeyCeremonyResponse }
  | { error: string }
> {
  if (hasPasskeyBridge()) {
    return runBridgeCeremony('create', options);
  }
  try {
    const response = await startRegistration({
      optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
    });
    return { response };
  } catch (err) {
    return { error: describeWebAuthnError(err) };
  }
}

export async function authenticateWithPasskey(
  options: PasskeyCeremonyOptions,
): Promise<
  | { response: AuthenticationResponseJSON | PasskeyCeremonyResponse }
  | { error: string }
> {
  if (hasPasskeyBridge()) {
    return runBridgeCeremony('get', options);
  }
  try {
    const response = await startAuthentication({
      optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    return { response };
  } catch (err) {
    return { error: describeWebAuthnError(err) };
  }
}

/** Collapse the browser's many failure shapes into a few reasons the UI names. */
function describeWebAuthnError(err: unknown): string {
  const cause =
    err instanceof WebAuthnError && err.cause instanceof Error
      ? err.cause
      : err;
  const name = cause instanceof Error ? cause.name : '';

  if (name === 'NotAllowedError' || name === 'AbortError') {
    // The person dismissed the prompt, or it timed out.
    return 'passkey-cancelled';
  }
  if (err instanceof WebAuthnError) {
    switch (err.code) {
      case 'ERROR_CEREMONY_ABORTED':
        return 'passkey-cancelled';
      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
        return 'passkey-already-registered';
      case 'ERROR_INVALID_RP_ID':
      case 'ERROR_INVALID_DOMAIN':
        return 'passkey-invalid-domain';
      case 'ERROR_AUTHENTICATOR_GENERAL_ERROR':
      case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
        return 'passkey-unsupported';
      default:
        break;
    }
  }
  if (name === 'SecurityError') {
    return 'passkey-invalid-domain';
  }
  if (name === 'NotSupportedError') {
    return 'passkey-unsupported';
  }
  console.error('Passkey ceremony failed:', err);
  return 'passkey-failed';
}
