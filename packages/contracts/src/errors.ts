import { ERROR_CODES } from '@mercatus/core';
import { z } from 'zod';

/**
 * The wire form of the error envelope (BUILD-PLAN §6.0). The codes themselves live in
 * @mercatus/core, because the classes that throw them are there and two lists would drift.
 */
export const errorCodeSchema = z.enum(ERROR_CODES);

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorEnvelopeShape = z.infer<typeof errorEnvelopeSchema>;
