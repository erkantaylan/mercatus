/**
 * apps/admin -- the platform console (BUILD-PLAN §7.4), a Vite + React SPA.
 *
 * The port comes from PORT, which the AppHost sets to whatever Aspire allocated. It used to be a
 * hard-coded 5174 that ignored the variable entirely -- harmless while §8.1's table held, and a
 * silent liar once ports went dynamic: the AppHost would announce one port to the edge while Vite
 * listened on another, and the console 502'd through Traefik with nothing in either log.
 *
 * `strictPort` on purpose. A silent fallback to "the next free port" would mean the edge routes to
 * a port this process is not on, and the gate screenshots whichever app started second -- exactly
 * the confusion BH1 exists to avoid.
 *
 * Routes are code-based (`createRoute`), so there is no @tanstack/router-plugin here and no
 * generated route tree in the repo -- see docs/decisions-made-overnight.md.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env['PORT'] ?? 5174);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    // Reachable from the edge as `console.localtest.me:<edge port>`, which means binding something
    // the Traefik container can route to and accepting that Host header (lessons/05).
    host: process.env['HOST'] ?? '127.0.0.1',
    allowedHosts: ['.localtest.me'],
  },
  preview: {
    port,
    strictPort: true,
  },
});
