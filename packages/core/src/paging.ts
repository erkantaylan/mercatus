/**
 * Every list endpoint returns { items, total } (BUILD-PLAN §6.0). No cursors: the POC has no
 * page large enough to need one, and a cursor is a contract you cannot take back cheaply.
 */

export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export function pagedResult<T>(items: readonly T[], total: number): PagedResult<T> {
  return { items, total };
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * Clamps rather than rejects: a limit of 10_000 is a client being optimistic, not an attack, and
 * a 400 there buys nothing. A negative offset is a bug in the caller and is clamped to 0.
 */
export function normalisePageRequest(input?: {
  limit?: number | undefined;
  offset?: number | undefined;
}): PageRequest {
  const limit = Math.min(Math.max(Math.trunc(input?.limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
  const offset = Math.max(Math.trunc(input?.offset ?? 0), 0);
  return { limit, offset };
}
