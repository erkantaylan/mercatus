/**
 * What a shopper is told when a shop is not selling (CG3).
 *
 * Two blocked states, two different sentences, and that is the whole reason this file exists
 * rather than one boolean. `blocked_passive` is the merchant's own state and the shopper is told
 * the shop is not taking orders; `blocked_unreachable` is OURS, and saying "the shop is closed"
 * there would blame a merchant for our outage. Browsing works in both -- neither is a hard stop.
 */
import type { StorefrontLicence } from '@mercatus/contracts';

export interface CheckoutNotice {
  readonly tone: 'warning' | 'danger';
  readonly title: string;
  readonly body: string;
}

export function checkoutNotice(licence: StorefrontLicence): CheckoutNotice | null {
  switch (licence.checkout) {
    case 'open':
      return null;
    case 'blocked_passive':
      return {
        tone: 'warning',
        title: 'This shop is not taking orders right now.',
        body: 'You can still browse the catalogue. Orders you have already placed are unaffected.',
      };
    case 'blocked_unreachable':
      return {
        tone: 'danger',
        title: 'Orders are paused for a moment.',
        body:
          'This is on our side, not the shop’s. Browsing works as normal and checkout comes back ' +
          'by itself once our platform is reachable again.',
      };
  }
}
