/**
 * The basket link in the header, with a live count.
 *
 * It renders `Basket` on the server and `Basket (n)` after hydration. That mismatch is deliberate
 * and unavoidable: the count is in localStorage, which the server cannot see, so the count is
 * read in an effect rather than during render. Reading it during render is what produces a
 * hydration error.
 */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { readBasket } from '@/lib/basket';

export function BasketLink({ slug }: { slug: string }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const refresh = () => {
      setCount(readBasket(slug).reduce((sum, line) => sum + line.qty, 0));
    };
    refresh();
    // 'storage' fires in other tabs; the custom event covers this one.
    window.addEventListener('mercatus:basket', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('mercatus:basket', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [slug]);

  return (
    <Link href={`/t/${slug}/basket`}>Basket{count ? ` (${String(count)})` : ''}</Link>
  );
}
