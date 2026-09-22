/**
 * The two formatters the console needs. Both take the wire's ISO strings.
 *
 * `lastSeen` is written as an age rather than a timestamp on purpose: the question an operator
 * asks of a dedicated box is "is it still reporting", and "4 minutes ago" answers that where
 * "2026-09-22T05:27:11Z" makes them do arithmetic (CE6, CL1).
 */
export function formatInstant(iso: string | null): string {
  if (!iso) return '--';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';
  return at.toLocaleString();
}

export function formatAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'never';

  const seconds = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}
