/**
 * apps/admin -- the platform console (BUILD-PLAN §7.4), on 5174.
 *
 * A SEPARATE APP from the merchant dashboard on purpose (BH1). Two apps, two token audiences:
 * this one holds `aud: "operator"` and the control plane refuses a merchant's `aud: "staff"` on
 * every route it calls. "One admin app with an isStaff flag" is how cross-tenant reads ship.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './router.js';
// The tokens and the reset are the shared ones (BUILD-PLAN §7.1). Order matters: tokens define
// the custom properties the reset's `body` rule reads.
import '@mercatus/ui/tokens.css';
import '@mercatus/ui/reset.css';
import './styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The console is a live operations view: a stale tenant status is the one thing it must not
      // show, because an operator reads it to decide whether to flip it.
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root.');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
