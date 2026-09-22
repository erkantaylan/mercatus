/**
 * OpenTelemetry, wired with zero configuration from the environment Aspire already sets
 * (BUILD-PLAN §8.2, EQ). Aspire's dashboard IS the telemetry stack -- no Grafana, no collector,
 * no extra container.
 *
 * This module is NOT imported by any application. It is loaded by the runtime, before the
 * application graph is evaluated:
 *
 *     node --import tsx --import ../../packages/core/src/telemetry.ts src/index.ts
 *
 * That ordering is the whole point. Instrumentation works by patching modules as they are
 * loaded, so anything imported before the SDK starts is never patched. Importing this from
 * `index.ts` would be too late for `fastify` and `postgres`, which `index.ts` pulls in through
 * `@mercatus/core` -- and the failure is silent: the service runs, the dashboard just stays
 * empty. The AppHost is therefore the only caller, which is also correct for another reason:
 * telemetry is an orchestration concern, and a service started by hand for a unit test has no
 * business dialling an exporter.
 *
 * Aspire injects, verified by reading /proc/<pid>/environ of a running store-pooled:
 *
 *     OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:19071
 *     OTEL_EXPORTER_OTLP_PROTOCOL=grpc
 *     OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=<per-run key>
 *     OTEL_SERVICE_NAME=store-pooled
 *     OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<per-replica>
 *
 * All five are read by the SDK itself. Nothing below restates them, because a value restated
 * here is a value that can disagree with the one the dashboard is actually listening on.
 *
 * No endpoint, no telemetry, no noise: a service started outside an AppHost gets a no-op.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

if (endpoint) {
  // `warn` keeps export failures visible -- a dashboard that stays empty because the exporter
  // cannot reach the collector is otherwise indistinguishable from one that is simply idle.
  // OTEL_LOG_LEVEL=debug turns this up to every batch.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  // HTTP gives the server span for every request and the client span for every outbound call;
  // pg gives the query underneath it. There is deliberately no fastify instrumentation:
  // @opentelemetry/instrumentation-fastify is deprecated in favour of @fastify/otel, which is a
  // plugin every app would have to register, and all it would add is a span per hook.
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  sdk.start();

  // No shutdown hook on purpose. Every app already owns SIGTERM/SIGINT for its own graceful
  // close, and a second handler here would either race it or, if it removed the app's
  // listeners to flush first, stop the database pool from closing. Aspire sets
  // OTEL_BSP_SCHEDULE_DELAY=1000, so at most the last second of spans is lost when a service
  // stops -- a cheaper trade than owning the shutdown order of every service in the repo.
}
