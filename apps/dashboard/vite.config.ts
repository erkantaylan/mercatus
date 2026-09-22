/**
 * The merchant dashboard's build (BUILD-PLAN §7.3). A plain Vite SPA on a fixed port -- it ships
 * with the instance, and the only difference between the pooled copy and a dedicated one is
 * VITE_STORE_API_URL (DK).
 */
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    // Must come before the React plugin: it writes src/routeTree.gen.ts from src/routes/*.
    tanstackRouter({ target: 'react', autoCodeSplitting: false }),
    react(),
  ],
  resolve: {
    alias: {
      // @mercatus/contracts imports @mercatus/core for three constants, and core's entry point
      // pulls in Fastify, pino and the OpenTelemetry SDK -- none of which can be bundled for a
      // browser. The shim re-exports those three constants from core's own source files, so the
      // contracts stay the single definition of every shape on the wire (lessons/07b).
      '@mercatus/core': fileURLToPath(new URL('./src/vendor/core-browser.ts', import.meta.url)),
    },
  },
  server: {
    // 5173 pooled, 5175 dedicated (BUILD-PLAN §8.1). strictPort so a taken port is a failure
    // rather than a silent move to another one that nothing else is configured for.
    port: Number(process.env['PORT'] ?? 5173),
    strictPort: true,
  },
});
