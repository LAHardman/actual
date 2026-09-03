import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasPasskeyBridge, runBridgeCeremony } from './passkey-bridge';

// The Android shell's side of this protocol lives in the app's bundled web
// extension, so these tests stand in for it: the point is that the two halves
// agree on the event names, the request id and the reply shape.

const REQUEST_EVENT = 'actual-passkey-request';
const RESPONSE_EVENT = 'actual-passkey-response';
const MARKER = 'data-actual-passkey-bridge';

type Request = { id: string; kind: string; optionsJson: string };

/** Stands in for the extension: answers each request with `reply`. */
function fakeBridge(
  reply: (request: Request) => Record<string, unknown> | null,
) {
  const seen: Request[] = [];
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Request>).detail;
    seen.push(detail);
    const payload = reply(detail);
    if (payload) {
      document.dispatchEvent(
        new CustomEvent(RESPONSE_EVENT, {
          detail: { id: detail.id, ...payload },
        }),
      );
    }
  };
  document.addEventListener(REQUEST_EVENT, listener);
  return {
    seen,
    remove: () => document.removeEventListener(REQUEST_EVENT, listener),
  };
}

afterEach(() => {
  document.documentElement.removeAttribute(MARKER);
  vi.useRealTimers();
});

describe('hasPasskeyBridge', () => {
  it('is false without the marker the extension sets', () => {
    expect(hasPasskeyBridge()).toBe(false);
  });

  it('is true once the extension has marked the document', () => {
    document.documentElement.setAttribute(MARKER, '1');
    expect(hasPasskeyBridge()).toBe(true);
  });
});

describe('runBridgeCeremony', () => {
  it('sends the ceremony as JSON and parses the reply', async () => {
    const bridge = fakeBridge(() => ({
      ok: true,
      responseJson: JSON.stringify({ id: 'cred-1', type: 'public-key' }),
      error: null,
    }));

    const result = await runBridgeCeremony('create', {
      challenge: 'abc',
      rp: { id: 'budget.example.com' },
    });

    expect(bridge.seen).toHaveLength(1);
    expect(bridge.seen[0].kind).toBe('create');
    expect(JSON.parse(bridge.seen[0].optionsJson)).toEqual({
      challenge: 'abc',
      rp: { id: 'budget.example.com' },
    });
    expect(result).toEqual({ response: { id: 'cred-1', type: 'public-key' } });

    bridge.remove();
  });

  it("passes the app's reason through so the UI can explain it", async () => {
    const bridge = fakeBridge(() => ({
      ok: false,
      responseJson: null,
      error: 'passkey-cancelled',
    }));

    expect(await runBridgeCeremony('get', { challenge: 'abc' })).toEqual({
      error: 'passkey-cancelled',
    });

    bridge.remove();
  });

  it('falls back to a generic reason when the app gives none', async () => {
    const bridge = fakeBridge(() => ({
      ok: false,
      responseJson: null,
      error: null,
    }));

    expect(await runBridgeCeremony('get', { challenge: 'abc' })).toEqual({
      error: 'passkey-failed',
    });

    bridge.remove();
  });

  it('does not trust a success that carries no response', async () => {
    const bridge = fakeBridge(() => ({
      ok: true,
      responseJson: null,
      error: null,
    }));

    expect(await runBridgeCeremony('get', { challenge: 'abc' })).toEqual({
      error: 'passkey-failed',
    });

    bridge.remove();
  });

  it('reports unparseable JSON rather than throwing', async () => {
    const bridge = fakeBridge(() => ({
      ok: true,
      responseJson: 'not json',
      error: null,
    }));

    expect(await runBridgeCeremony('create', { challenge: 'abc' })).toEqual({
      error: 'passkey-failed',
    });

    bridge.remove();
  });

  // Two ceremonies can overlap if someone is quick, and a stale reply from an
  // abandoned one must not resolve the live request.
  it('ignores a reply meant for a different request', async () => {
    const bridge = fakeBridge(request => {
      document.dispatchEvent(
        new CustomEvent(RESPONSE_EVENT, {
          detail: {
            id: 'some-other-request',
            ok: true,
            responseJson: JSON.stringify({ id: 'wrong' }),
            error: null,
          },
        }),
      );
      return {
        ok: true,
        responseJson: JSON.stringify({ id: 'right', for: request.kind }),
        error: null,
      };
    });

    expect(await runBridgeCeremony('get', { challenge: 'abc' })).toEqual({
      response: { id: 'right', for: 'get' },
    });

    bridge.remove();
  });

  it('gives up if the app never answers', async () => {
    vi.useFakeTimers();
    const bridge = fakeBridge(() => null);

    const pending = runBridgeCeremony('get', { challenge: 'abc' });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await pending).toEqual({ error: 'passkey-cancelled' });

    bridge.remove();
  });

  it('stops listening once a ceremony has settled', async () => {
    const bridge = fakeBridge(() => ({
      ok: true,
      responseJson: JSON.stringify({ id: 'cred-1' }),
      error: null,
    }));

    await runBridgeCeremony('create', { challenge: 'abc' });
    const before = bridge.seen.length;

    // A late duplicate reply for the same id must not throw or re-resolve.
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          id: bridge.seen[0].id,
          ok: true,
          responseJson: '{}',
          error: null,
        },
      }),
    );

    expect(bridge.seen).toHaveLength(before);

    bridge.remove();
  });
});
