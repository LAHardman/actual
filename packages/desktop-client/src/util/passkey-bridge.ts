import type {
  PasskeyCeremonyOptions,
  PasskeyCeremonyResponse,
} from '@actual-app/core/types/models';

/**
 * A native passkey bridge, as provided by Actual's Android shell.
 *
 * That app embeds a browser engine, and Android refuses WebAuthn calls made
 * for a website by an app it does not recognise as a browser. The app instead
 * performs the ceremony natively, as itself, and exposes it here. The JSON is
 * the same either way, so this is a straight swap for `navigator.credentials`
 * rather than a different protocol.
 *
 * The channel is DOM events because a browser extension's content script and
 * the page cannot hand each other objects directly.
 */

const MARKER = 'data-actual-passkey-bridge';
const REQUEST_EVENT = 'actual-passkey-request';
const RESPONSE_EVENT = 'actual-passkey-response';

// Long enough for someone to find their finger, short enough that a bridge
// that has stopped answering does not hang the button forever.
const CEREMONY_TIMEOUT_MS = 120_000;

type BridgeReply = {
  id: string;
  ok: boolean;
  responseJson: string | null;
  error: string | null;
};

export function hasPasskeyBridge(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute(MARKER) === '1'
  );
}

export function runBridgeCeremony(
  kind: 'create' | 'get',
  options: PasskeyCeremonyOptions,
): Promise<{ response: PasskeyCeremonyResponse } | { error: string }> {
  return new Promise(resolve => {
    const id = globalThis.crypto.randomUUID();
    let settled = false;

    const finish = (
      result: { response: PasskeyCeremonyResponse } | { error: string },
    ) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(RESPONSE_EVENT, onResponse);
      clearTimeout(timer);
      resolve(result);
    };

    function onResponse(event: Event) {
      const detail = (event as CustomEvent<BridgeReply>).detail;
      if (!detail || detail.id !== id) {
        return;
      }

      if (!detail.ok || !detail.responseJson) {
        finish({ error: detail.error ?? 'passkey-failed' });
        return;
      }

      try {
        finish({
          response: JSON.parse(detail.responseJson) as PasskeyCeremonyResponse,
        });
      } catch {
        finish({ error: 'passkey-failed' });
      }
    }

    const timer = setTimeout(
      () => finish({ error: 'passkey-cancelled' }),
      CEREMONY_TIMEOUT_MS,
    );

    document.addEventListener(RESPONSE_EVENT, onResponse);
    document.dispatchEvent(
      new CustomEvent(REQUEST_EVENT, {
        detail: { id, kind, optionsJson: JSON.stringify(options) },
      }),
    );
  });
}
