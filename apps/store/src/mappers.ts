/**
 * Database rows -> the shapes in @mercatus/contracts.
 *
 * The mapping is explicit rather than a spread, because a column added to the schema should not
 * appear on the wire until someone decides it should. Timestamps become ISO strings here and
 * nowhere else.
 */
import type { Order, OrderDetail, OrderLine, Product, StoreBranding } from '@mercatus/contracts';
import type { OrderLineRow, OrderRow, ProductRow, TenantRow } from '@mercatus/db-store';

export function productDto(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    priceMinor: row.priceMinor,
    currency: row.currency,
    imageUrl: row.imageUrl,
    stock: row.stock,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function orderDto(row: OrderRow): Order {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    totalMinor: row.totalMinor,
    currency: row.currency,
    placedAt: row.placedAt.toISOString(),
  };
}

export function orderLineDto(row: OrderLineRow): OrderLine {
  return {
    id: row.id,
    productId: row.productId,
    titleSnapshot: row.titleSnapshot,
    unitPriceMinor: row.unitPriceMinor,
    qty: row.qty,
  };
}

export function orderDetailDto(order: OrderRow, lines: readonly OrderLineRow[]): OrderDetail {
  return { ...orderDto(order), lines: lines.map(orderLineDto) };
}

/** Branding is rendered as CSS custom properties by the storefront; a dedicated store is fully branded (DW). */
export function brandingDto(row: TenantRow): StoreBranding {
  const branding = row.branding;
  return {
    name: row.name,
    slug: row.slug,
    ...(branding.logoUrl === undefined ? {} : { logoUrl: branding.logoUrl }),
    ...(branding.accent === undefined ? {} : { accent: branding.accent }),
    ...(branding.bg === undefined ? {} : { bg: branding.bg }),
    ...(branding.fg === undefined ? {} : { fg: branding.fg }),
  };
}
