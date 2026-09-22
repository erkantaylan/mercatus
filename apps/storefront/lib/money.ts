/**
 * Minor units and a currency code into something a human reads.
 *
 * Money is an integer in minor units everywhere in this repo (BUILD-PLAN §5), so this is the only
 * place a division by 100 is allowed to appear. The same rule as fake-bank's page; if a third
 * surface needs it, it moves to @mercatus/ui.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}
