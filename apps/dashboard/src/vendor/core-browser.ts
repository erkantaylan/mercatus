/**
 * The browser-safe slice of @mercatus/core, aliased in over the real package by vite.config.ts.
 *
 * @mercatus/contracts -- the one definition of every shape on the wire -- imports exactly three
 * constants from core. Core's entry point also re-exports the Fastify server helper, so importing
 * the package as a whole drags Fastify, pino, jose and the OpenTelemetry SDK into a browser
 * bundle. Reaching past its entry point to the two files that hold the constants keeps the
 * contracts importable here without a second copy of the codes or the page limits.
 */
export { ERROR_CODES } from '../../../../packages/core/src/errors.js';
export { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../../../../packages/core/src/paging.js';
