/**
 * @mercatus/contracts -- the Zod schemas every app validates against, and the types inferred from
 * them (BUILD-PLAN §6.0). The schema is the contract; there is no separate hand-written type, and
 * no route validates by hand.
 *
 * These are also what @fastify/swagger turns into the OpenAPI document that Scalar serves at
 * /docs. Generation stops at documentation -- there is no client codegen in this POC
 * (decisions-made-overnight.md, task 00).
 */
export * from './errors.js';
export * from './common.js';
export * from './store.js';
export * from './platform.js';
