/**
 * The licence banner (CG3, and the table in ES).
 *
 * Two facts, never collapsed into one flag. `status` is the TENANT's -- passive means they did
 * not pay, and the dashboard stays FULLY USABLE because the page that fixes it is the last thing
 * to take away. `state` is OURS -- grace and read_only mean the store could not reach the control
 * plane, which must not look to the merchant like being cut off for non-payment.
 */
import type { LicenceView } from '@mercatus/contracts';

export interface LicenceBanner {
  readonly tone: 'info' | 'warning' | 'danger';
  readonly title: string;
  readonly body: string;
}

export function licenceBanner(view: LicenceView): LicenceBanner | null {
  switch (view.state) {
    case 'healthy':
      return null;
    case 'passive':
      return {
        tone: 'warning',
        title: 'Store is passive.',
        body:
          'Shoppers can browse your catalogue but cannot check out. Everything in this dashboard ' +
          'keeps working, including the settings that fix it.',
      };
    case 'grace':
      return {
        tone: 'info',
        title: 'Working offline.',
        body:
          'This store cannot reach the platform right now. That is our side, not yours: your shop ' +
          'and this dashboard carry on as normal until the grace window expires.',
      };
    case 'read_only':
      return {
        tone: 'danger',
        title: 'Read-only.',
        body:
          'The platform has been unreachable for longer than the grace window, so changes are ' +
          'refused until it returns. Your data is untouched and your shop still serves its catalogue.',
      };
  }
}

/** True while the store refuses writes -- the forms grey out rather than failing at submit. */
export function writesRefused(view: LicenceView | undefined): boolean {
  return view?.state === 'read_only';
}
