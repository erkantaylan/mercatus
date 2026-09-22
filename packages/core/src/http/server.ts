/**
 * The composition helper (BUILD-PLAN §6.0). Fifty lines, not a framework on a framework.
 *
 * It wires the five things every service in this repo needs and nothing else: the logger, the
 * error envelope, CORS, the Zod type provider, and the OpenAPI document that Scalar serves at
 * /docs. The auth and tenancy hook goes on here too, because a service that can register a route
 * must not be able to register one that skips the tenant decision.
 *
 * The schema is the contract: validatorCompiler and serializerCompiler mean a route's Zod schema
 * validates the request AND shapes the response, so an accidental extra field never reaches the
 * wire and the OpenAPI document cannot drift from the code.
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import type { AuthContextOptions } from '../auth/plugin.js';
import { registerAuthContext } from '../auth/plugin.js';
import { isMercatusError, statusOf, toErrorEnvelope, ValidationError } from '../errors.js';

/** A Fastify instance whose route schemas are Zod schemas. Every app in this repo holds one. */
export type MercatusServer = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface CreateServerOptions {
  /** Appears in the OpenAPI document and in every log line. */
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly logLevel?: string;
  /** Omitted only by a service with no tokens and no tenants. */
  readonly auth?: AuthContextOptions;
  /** `/docs`. Set to null to serve no documentation. */
  readonly docsPath?: `/${string}` | null;
}

export async function createServer(options: CreateServerOptions): Promise<MercatusServer> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
      base: { service: options.name, version: options.version },
    },
    // Aspire and Traefik both sit in front of these services; without this the tenant resolver
    // would see the proxy's host rather than the one the shopper typed (§3.6).
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // The POC's front ends are served from other ports on the same machine, and a dedicated
  // instance's dashboard talks to its own API. Locked down when there is a real origin list.
  //
  // `methods` is NOT optional: @fastify/cors 11 defaults to the CORS-safelisted set,
  // 'GET,HEAD,POST', so a browser's preflight for PATCH or DELETE is answered with an
  // allow-methods header that omits them and the real request is never sent. Found from the
  // dashboard, where editing a product failed with no request in the log at all -- only the 204
  // preflight (lessons/07b).
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  if (options.docsPath !== null) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: options.name,
          version: options.version,
          ...(options.description === undefined ? {} : { description: options.description }),
        },
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(scalar, { routePrefix: options.docsPath ?? '/docs' });
  }

  if (options.auth) registerAuthContext(app, options.auth);

  /**
   * One envelope for everything (§6.0), and no stack ever leaves the process. S1 lives here: the
   * client gets the generic code, `logDetail` carries the check that actually failed into the log
   * and cannot be serialised by accident, because toEnvelope() does not know about it.
   */
  app.setErrorHandler((error, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation.map((v) => ({ path: v.instancePath, message: v.message }));
      const wrapped = new ValidationError('The request did not validate.', { details: { issues } });
      req.log.info({ issues, route: req.url }, 'request failed validation');
      reply.status(wrapped.status).send(wrapped.toEnvelope());
      return;
    }

    if (isResponseSerializationError(error)) {
      // The handler returned something the contract does not describe. That is our bug, and the
      // client gets a bare 500 rather than a shape nobody promised.
      req.log.error({ err: error, route: req.url }, 'response did not match its schema');
      reply.status(500).send(toErrorEnvelope(error));
      return;
    }

    const status = statusOf(error);
    const logDetail = isMercatusError(error) ? error.logDetail : undefined;
    if (status >= 500) {
      req.log.error({ err: error, logDetail, route: req.url }, 'request failed');
    } else {
      req.log.info(
        { code: isMercatusError(error) ? error.code : 'INTERNAL', logDetail, route: req.url },
        'request refused',
      );
    }
    reply.status(status).send(toErrorEnvelope(error));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${req.url}.` } });
  });

  return app;
}
