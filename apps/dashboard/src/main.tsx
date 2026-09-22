/**
 * The composition root of the dashboard: one API client, one auth adapter, one query cache, one
 * router. Everything else receives them.
 */
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiError, createStoreClient } from './api/client.js';
import { createAuthAdapter } from './auth/adapter.js';
import { session } from './auth/session.js';
import { createAppRouter } from './router.js';

// The shared tokens, from the one place a colour or a spacing step is written down (BUILD-PLAN
// §7.1). Order matters: reset, then tokens, then what this app adds.
import '@mercatus/ui/reset.css';
import '@mercatus/ui/tokens.css';
import './styles/app.css';

const client = createStoreClient(() => session.token());
const adapter = createAuthAdapter(client);

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      // A token the store will not accept is not a broken screen, it is a signed-out merchant.
      // Access tokens are short by design (BC2), so this is the ordinary end of a session.
      if (error instanceof ApiError && error.status === 401) session.clear();
    },
  }),
  defaultOptions: {
    // A failed request here means the store said no, not that the network flickered; retrying
    // three times only delays the message.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const router = createAppRouter({ client, adapter, queryClient });

// Signing in or out changes what the root guard decides, so the router has to re-run it.
session.subscribe(() => {
  void router.invalidate();
});

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('index.html is missing #root.');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
