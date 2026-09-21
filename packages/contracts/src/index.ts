/**
 * @mercatus/contracts -- the Zod schemas every app validates against, and the types inferred
 * from them. The schema is the contract; there is no separate hand-written type.
 *
 * Products, orders, checkout and the platform schemas land with the tasks that need them
 * (BUILD-PLAN §6). Only the error envelope exists so far.
 */
export * from './errors.js';
