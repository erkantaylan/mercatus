/**
 * The root shell (BUILD-PLAN §7.2). It imports the design tokens and nothing else -- the store
 * shell, with the tenant's branding on it, is `app/t/[slug]/layout.tsx`, one level down.
 *
 * Order matters: the reset reads `--mc-bg` and `--mc-fg`, so the tokens have to be defined first.
 */
import '@mercatus/ui/tokens.css';
import '@mercatus/ui/reset.css';
import './globals.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'mercatus storefront',
  description: 'A shop on the mercatus platform.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
