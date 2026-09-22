/**
 * apps/admin -- the platform console (BUILD-PLAN §7.4), a Vite + React SPA on 5174.
 *
 * `strictPort` on purpose: 5174 is the console's port in §8.1 and the dashboard's is 5173. A
 * silent fallback to "the next free port" would mean the gate screenshots whichever app started
 * second, which is exactly the confusion BH1 exists to avoid.
 *
 * Routes are code-based (`createRoute`), so there is no @tanstack/router-plugin here and no
 * generated route tree in the repo -- see docs/decisions-made-overnight.md.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
});
