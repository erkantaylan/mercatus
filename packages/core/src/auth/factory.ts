import { MercatusError } from '../errors.js';
import { LogtoAuthAdapter, type LogtoAuthAdapterOptions } from './oidc-adapter.js';
import { StubAuthAdapter, type StubAuthAdapterOptions } from './stub-adapter.js';
import type { AuthAdapter } from './types.js';

export interface AuthAdapterConfig {
  /** AUTH_ADAPTER. */
  readonly adapter: 'stub' | 'oidc';
  readonly stub?: StubAuthAdapterOptions;
  readonly oidc?: LogtoAuthAdapterOptions;
}

/**
 * The one place an adapter is chosen. Task 03 calls this from the composition root with the
 * parsed config; nothing else constructs an adapter.
 */
export function createAuthAdapter(config: AuthAdapterConfig): AuthAdapter {
  if (config.adapter === 'stub') {
    if (!config.stub) {
      throw new MercatusError('CONFIG_INVALID', 500, 'AUTH_ADAPTER=stub needs AUTH_STUB_SECRET.');
    }
    return new StubAuthAdapter(config.stub);
  }
  if (!config.oidc) {
    throw new MercatusError(
      'CONFIG_INVALID',
      500,
      'AUTH_ADAPTER=oidc needs OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_JWKS_CACHE_PATH.',
    );
  }
  return new LogtoAuthAdapter(config.oidc);
}
