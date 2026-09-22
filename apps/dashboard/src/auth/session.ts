/**
 * The signed-in merchant, and nothing else (BUILD-PLAN §7.3).
 *
 * A session is one tenant's (BC1): the token carries `tid`, so switching stores means signing in
 * again and minting a new one, never widening the one in hand. That is why the slug lives beside
 * the token here -- it is what the token says, not a choice this app can edit.
 *
 * The store is an external store in React's sense, so the shell re-renders on sign-in and
 * sign-out without a provider.
 */
export type StaffRole = 'owner' | 'staff';

export interface StaffSession {
  readonly accessToken: string;
  /** Seconds since the epoch, as the token itself reports it. */
  readonly expiresAt: number;
  readonly slug: string;
  readonly role: StaffRole;
}

/**
 * BUILD-PLAN says access token in memory, refresh token in localStorage. The stub adapter issues
 * no refresh token, so there is nothing to keep there and a reload would sign the merchant out
 * every time. The whole session is persisted instead -- a dev-only token, minted by a dev-only
 * route, behind AUTH_ADAPTER=stub. The Identity phase replaces this file with the real split
 * (decisions-made-overnight.md, task 07b).
 */
const STORAGE_KEY = 'mercatus.dashboard.session';

let current: StaffSession | null = read();
const listeners = new Set<() => void>();

function read(): StaffSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as StaffSession;
    if (typeof value.accessToken !== 'string' || typeof value.slug !== 'string') return null;
    // An expired token is not a session. The store would answer 401 and the app would look broken
    // instead of signed out.
    if (value.expiresAt * 1000 <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export const session = {
  get: (): StaffSession | null => current,

  token: (): string | null => current?.accessToken ?? null,

  set(value: StaffSession): void {
    current = value;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Private browsing, or storage disabled. The session still works for this tab.
    }
    emit();
  },

  clear(): void {
    current = null;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // As above.
    }
    emit();
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export type SessionStore = typeof session;
