/**
 * The error envelope is the contract (BUILD-PLAN §6.0). Every non-2xx response, from every
 * service, is:
 *
 *     { "error": { "code": "PRODUCT_NOT_FOUND", "message": "…", "details": {…}? } }
 *
 * `code` is the stable part -- callers switch on it. `message` is for a human and may change
 * between releases without ceremony. A stack never leaves the process.
 *
 * S1: auth-shaped failures return ONE generic code so the endpoint cannot be used to enumerate
 * accounts, and put the check that actually failed in `logDetail`, which is logged and never
 * serialised.
 */

export const ERROR_CODES = [
  // generic
  'INTERNAL',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  // auth -- deliberately coarse (S1)
  'UNAUTHENTICATED',
  'FORBIDDEN',
  // tenancy
  'MISSING_TENANT_CONTEXT',
  'TENANT_MISMATCH',
  'TENANT_NOT_FOUND',
  // licensing / degradation (CG3: these two are never collapsed into one)
  'LICENCE_PASSIVE',
  'CONTROL_PLANE_UNREACHABLE',
  // commerce
  'PRODUCT_NOT_FOUND',
  'ORDER_NOT_FOUND',
  'INSUFFICIENT_STOCK',
  // boot
  'CONFIG_INVALID',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export interface MercatusErrorOptions {
  /** Serialised to the client. Never put anything here you would not print on a billboard. */
  readonly details?: Record<string, unknown>;
  /** Logged, never serialised. This is where the real reason goes (S1). */
  readonly logDetail?: string;
  readonly cause?: unknown;
}

/**
 * Base of the hierarchy. Prefer a subclass; construct this directly only for a code that has no
 * subclass yet.
 */
export class MercatusError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly logDetail: string | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: MercatusErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.logDetail = options.logDetail;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class ValidationError extends MercatusError {
  constructor(message = 'The request did not validate.', options?: MercatusErrorOptions) {
    super('VALIDATION_FAILED', 400, message, options);
  }
}

/** 401. One code for every authentication failure (S1). */
export class UnauthenticatedError extends MercatusError {
  constructor(message = 'Not authenticated.', options?: MercatusErrorOptions) {
    super('UNAUTHENTICATED', 401, message, options);
  }
}

/** 403. One code for every authorisation failure (S1). */
export class ForbiddenError extends MercatusError {
  constructor(message = 'Not permitted.', options?: MercatusErrorOptions) {
    super('FORBIDDEN', 403, message, options);
  }
}

export class NotFoundError extends MercatusError {
  constructor(message = 'Not found.', options?: MercatusErrorOptions) {
    super('NOT_FOUND', 404, message, options);
  }
}

export class ConflictError extends MercatusError {
  constructor(message = 'Conflict.', options?: MercatusErrorOptions) {
    super('CONFLICT', 409, message, options);
  }
}

/**
 * 500, and always a bug. Nothing that reaches the database may run without tenant context; when
 * it does, we fail loudly here rather than quietly defaulting to "some tenant" (BE1).
 */
export class MissingTenantContextError extends MercatusError {
  constructor(message = 'No tenant context is established for this request.') {
    super('MISSING_TENANT_CONTEXT', 500, message);
  }
}

/**
 * 403. BI1: the token names the tenant; the host or route only selects branding. When they
 * disagree it is a refusal, never a switch.
 */
export class TenantMismatchError extends MercatusError {
  constructor(message = 'Not permitted.', options?: MercatusErrorOptions) {
    super('TENANT_MISMATCH', 403, message, options);
  }
}

export class TenantNotFoundError extends MercatusError {
  constructor(message = 'Unknown store.', options?: MercatusErrorOptions) {
    super('TENANT_NOT_FOUND', 404, message, options);
  }
}

/**
 * 402. The tenant's own licence says passive -- their problem, and they keep the dashboard that
 * fixes it. Never returned because we could not reach the control plane (CG3).
 */
export class LicencePassiveError extends MercatusError {
  constructor(message = 'This store is not currently taking orders.', options?: MercatusErrorOptions) {
    super('LICENCE_PASSIVE', 402, message, options);
  }
}

/**
 * 503. Our problem: the control plane is unreachable and the grace window has expired (CG1,
 * CG3). Browsing still works; this is the terminal state, not a hard stop.
 */
export class ControlPlaneUnreachableError extends MercatusError {
  constructor(message = 'Temporarily unable to take orders.', options?: MercatusErrorOptions) {
    super('CONTROL_PLANE_UNREACHABLE', 503, message, options);
  }
}

export class InsufficientStockError extends MercatusError {
  constructor(message = 'Not enough stock.', options?: MercatusErrorOptions) {
    super('INSUFFICIENT_STOCK', 409, message, options);
  }
}

/** Thrown at boot by config parsing, with the name of the variable. Never at first request. */
export class ConfigInvalidError extends MercatusError {
  constructor(message: string, options?: MercatusErrorOptions) {
    super('CONFIG_INVALID', 500, message, options);
  }
}

export function isMercatusError(value: unknown): value is MercatusError {
  return value instanceof MercatusError;
}

/** Status for anything thrown. Unknown throwables are 500. */
export function statusOf(value: unknown): number {
  return isMercatusError(value) ? value.status : 500;
}

/**
 * Anything thrown -> the envelope. An unrecognised throwable becomes a bare INTERNAL: no
 * message, no stack, nothing derived from it reaches the client.
 */
export function toErrorEnvelope(value: unknown): ErrorEnvelope {
  if (isMercatusError(value)) return value.toEnvelope();
  return { error: { code: 'INTERNAL', message: 'Internal error.' } };
}
