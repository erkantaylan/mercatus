/**
 * The operator session.
 *
 * It holds an `aud: "operator"` token and nothing else. BH1 is a property of the TOKEN, not of a
 * code path: a merchant's `aud: "staff"` token is refused by every route this app calls, so there
 * is no "is this person staff" branch anywhere in the console and there is no way to add one
 * without changing the control plane's verifier.
 *
 * localStorage, because this is the POC's stub login and a page reload that logs the operator out
 * would make the console tedious to demo. The Identity phase replaces the whole file: the token
 * then comes from an OIDC redirect, and an operator session that survives a browser restart stops
 * being acceptable.
 *
 * It is a small external store rather than a plain getter because the shell reads it too: signing
 * in has to light up the nav, and signing out has to put it away, without a reload. The snapshot
 * is CACHED and only replaced on a write -- useSyncExternalStore compares snapshots by identity,
 * so re-parsing the JSON on every call would hand it a new object every render and loop forever.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'mercatus.admin.session';

export interface OperatorSession {
  readonly accessToken: string;
  /** Seconds since the epoch, from the token's own `exp`. */
  readonly expiresAt: number;
  readonly subject: string;
}

const listeners = new Set<() => void>();
/** `undefined` means "not read from storage yet"; `null` means "read, and there is none". */
let cached: OperatorSession | null | undefined;

function load(): OperatorSession | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private windows and blocked site data both throw rather than return null.
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Partial<OperatorSession>;
    if (typeof value.accessToken !== 'string') return null;
    if (typeof value.expiresAt !== 'number') return null;
    if (typeof value.subject !== 'string') return null;
    // An expired token is not a session. Treating it as one means every screen renders, then
    // every request 401s -- a worse answer than the login page.
    if (value.expiresAt * 1000 <= Date.now()) return null;
    return { accessToken: value.accessToken, expiresAt: value.expiresAt, subject: value.subject };
  } catch {
    return null;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function readSession(): OperatorSession | null {
  if (cached === undefined) cached = load();
  return cached;
}

export function writeSession(session: OperatorSession): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Nothing to do: the console still works for this tab, it just will not survive a reload.
  }
  cached = session;
  emit();
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same as above.
  }
  cached = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSession(): OperatorSession | null {
  return useSyncExternalStore(subscribe, readSession, readSession);
}
