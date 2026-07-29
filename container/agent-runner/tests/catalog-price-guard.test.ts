import { describe, it, expect } from 'vitest';
import {
  num,
  parseTiers,
  expectedTier,
  pricesEqual,
  describeTiers,
  checkItems,
  buildRejectionMessage,
  overrideCapExceeded,
  indexRows,
  GuardUnavailable,
  type CatalogRow,
  type GuardItem,
} from '../src/catalog-price-guard.js';

/** Real rows, copied from the live catalog on 2026-07-27. */
function row(partial: Partial<CatalogRow> & { sku: string }): CatalogRow {
  return {
    producto_id: null,
    nombre: null,
    presentacion: null,
    precio_publico_directo: null,
    precio_2: null,
    min_piezas_precio_2: null,
    precio_3: null,
    min_piezas_precio_3: null,
    ...partial,
  };
}

// Verbatim from the live catalog. The third tier ($90 from 10 pcs) is the whole reason the
// guard has to check qualification and not just membership: $90 IS a real catalog price, and
// quoting it on a 4-piece order is exactly what went wrong in the incident.
const MOSSI = row({
  sku: '12485',
  nombre: 'MOSSI SUBLIME LAVANDA 10L LIMPIADOR MULTIUSOS DESINFECTANTE',
  presentacion: 'GARRAFA 10L',
  precio_publico_directo: 110,
  precio_2: 95,
  min_piezas_precio_2: '2', // the API returns this as a string
  precio_3: 90,
  min_piezas_precio_3: '10',
});

const MOSSI_CAJA = row({
  sku: '12485',
  nombre: 'MOSSI SUBLIME LAVANDA 10L LIMPIADOR MULTIUSOS DESINFECTANTE',
  presentacion: 'CAJA 2 PZAS 10L',
  precio_publico_directo: 190,
  precio_2: 180,
  min_piezas_precio_2: '5',
});

const PINOSIIQ = row({
  sku: '43177',
  nombre: 'PINOSIIQ 10L LIMPIADOR DESINFECTANTE CON ACEITE DE PINO',
  presentacion: 'GARRAFA 10L',
  precio_publico_directo: 140,
  precio_2: 120,
  min_piezas_precio_2: '2',
  precio_3: 115,
  min_piezas_precio_3: '10',
});

const CLORO_CAMBIO = row({
  sku: '41279',
  nombre: 'CLOROSIIQ BIDON 20L A CAMBIO SUPER PROMOCION',
  presentacion: 'BIDON 20L A CAMBIO',
  precio_publico_directo: 100, // every other tier null — the flat-price shape
});

function item(over: Partial<GuardItem> = {}): GuardItem {
  return { sku: '12485', qty: 4, nombre: 'MOSSI LAVANDA 10L', unit_price: 95, ...over };
}

function index(...rows: CatalogRow[]): Map<string, CatalogRow[]> {
  const m = new Map<string, CatalogRow[]>();
  for (const r of rows) {
    const list = m.get(r.sku);
    if (list) list.push(r);
    else m.set(r.sku, [r]);
  }
  return m;
}

describe('num', () => {
  it('parses the string quantities the API actually returns', () => {
    expect(num('2')).toBe(2);
    expect(num(110)).toBe(110);
  });

  it('never produces NaN — a NaN tier would accept every price', () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('   ')).toBeNull();
    expect(num('N/A')).toBeNull();
    expect(num(NaN)).toBeNull();
  });
});

describe('parseTiers', () => {
  it('builds the ladder for a three-tier product', () => {
    expect(parseTiers(MOSSI)).toEqual([
      { min: 1, price: 110 },
      { min: 2, price: 95 },
      { min: 10, price: 90 },
    ]);
  });

  it('builds a three-tier ladder sorted by minimum', () => {
    expect(parseTiers(PINOSIIQ)).toEqual([
      { min: 1, price: 140 },
      { min: 2, price: 120 },
      { min: 10, price: 115 },
    ]);
  });

  it('handles an all-null-tiers row without crashing', () => {
    expect(parseTiers(CLORO_CAMBIO)).toEqual([{ min: 1, price: 100 }]);
  });

  it('drops a tier whose min_piezas is an empty string', () => {
    const broken = row({ ...MOSSI, min_piezas_precio_2: '' });
    expect(parseTiers(broken)).toEqual([
      { min: 1, price: 110 },
      { min: 10, price: 90 },
    ]);
  });

  it('drops zero-priced tiers', () => {
    const zeroed = row({ ...MOSSI, precio_2: 0 });
    expect(parseTiers(zeroed)).toEqual([
      { min: 1, price: 110 },
      { min: 10, price: 90 },
    ]);
  });
});

describe('expectedTier', () => {
  const tiers = parseTiers(PINOSIIQ);

  it('picks the bracket the quantity actually reaches', () => {
    expect(expectedTier(tiers, 1)?.price).toBe(140);
    expect(expectedTier(tiers, 2)?.price).toBe(120);
    expect(expectedTier(tiers, 9)?.price).toBe(120);
    expect(expectedTier(tiers, 10)?.price).toBe(115);
    expect(expectedTier(tiers, 500)?.price).toBe(115);
  });

  it('handles fractional quantities (KG/LT units)', () => {
    expect(expectedTier(tiers, 1.5)?.price).toBe(140);
  });

  it('returns null for an empty ladder', () => {
    expect(expectedTier([], 3)).toBeNull();
  });
});

describe('pricesEqual', () => {
  it('absorbs float noise but catches a one-centavo difference', () => {
    expect(pricesEqual(95, 95.0000001)).toBe(true);
    expect(pricesEqual(95, 95.01)).toBe(false);
    expect(pricesEqual(0.1 + 0.2, 0.3)).toBe(true);
  });
});

describe('describeTiers', () => {
  it('renders the ladder the way the agent reads it back', () => {
    expect(describeTiers(parseTiers(MOSSI))).toBe(
      '$110.00 (1 pza) · $95.00 (desde 2 pzas) · $90.00 (desde 10 pzas)',
    );
  });
});

describe('checkItems — the incident', () => {
  it('rejects the fossil price that caused this whole thing', () => {
    const { rejections } = checkItems(
      [item({ unit_price: 90, qty: 4 })],
      index(MOSSI, MOSSI_CAJA),
    );
    expect(rejections).toHaveLength(1);
    const r = rejections[0];
    // $90 exists in the catalog, but only from 10 pieces — the order is 4.
    expect(r.type).toBe('insufficient_qty');
    if (r.type === 'insufficient_qty') {
      expect(r.sent).toBe(90);
      expect(r.requiresQty).toBe(10);
      expect(r.expected).toBe(95);
      // Catalog truth, not the agent's claim — so a wrong product name is visible in logs.
      expect(r.nombre).toContain('SUBLIME LAVANDA');
    }
  });

  it('accepts that same price once the order actually reaches the volume', () => {
    const { rejections } = checkItems([item({ unit_price: 90, qty: 10 })], index(MOSSI));
    expect(rejections).toHaveLength(0);
  });

  it('rejects a price that matches no tier at all', () => {
    const { rejections } = checkItems([item({ unit_price: 77, qty: 4 })], index(MOSSI));
    expect(rejections[0].type).toBe('price_mismatch');
  });

  it('accepts the correct wholesale price with no warning', () => {
    const { rejections, warnings } = checkItems([item({ unit_price: 95, qty: 4 })], index(MOSSI));
    expect(rejections).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('accepts a real catalog price at the wrong bracket, but warns', () => {
    const { rejections, warnings } = checkItems([item({ unit_price: 110, qty: 5 })], index(MOSSI));
    expect(rejections).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('$95.00');
  });

  it('does not let a sibling presentation launder an unqualified price', () => {
    // 180 is real, but it belongs to CAJA from 5 — a 2-unit order does not qualify.
    const { rejections } = checkItems(
      [item({ unit_price: 180, qty: 2 })],
      index(MOSSI, MOSSI_CAJA),
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0].type).toBe('insufficient_qty');
  });

  it('accepts a flat-priced product with all tiers null', () => {
    const it41279 = item({ sku: '41279', unit_price: 100, qty: 4, nombre: 'CLORO BIDON' });
    const { rejections, warnings } = checkItems([it41279], index(CLORO_CAMBIO));
    expect(rejections).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('accepts a price that exists on a sibling presentation of the same SKU', () => {
    const caja = row({ ...MOSSI, presentacion: 'CAJA 2 PZAS 10L', precio_publico_directo: 180, precio_2: null, min_piezas_precio_2: null });
    const { rejections } = checkItems([item({ unit_price: 180, qty: 1 })], index(MOSSI, caja));
    expect(rejections).toHaveLength(0);
  });

  it('rejects an unknown SKU (it would get printed on the PDF)', () => {
    const { rejections } = checkItems([item({ sku: '99999' })], index(MOSSI));
    expect(rejections).toHaveLength(1);
    expect(rejections[0].type).toBe('unknown_sku');
  });

  it('skips items carrying a price_override entirely', () => {
    const promo = item({
      unit_price: 33.33,
      price_override: { kind: 'promocion', reason: 'Promo 3x4L MOSSI $100 vigente julio 2026' },
    });
    const { rejections, warnings } = checkItems([promo], index(MOSSI));
    expect(rejections).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('collects every bad item so the agent gets one round-trip, not four', () => {
    const { rejections } = checkItems(
      [
        item({ unit_price: 90 }),
        item({ sku: '43177', unit_price: 100, qty: 3, nombre: 'PINOSIIQ 10L' }),
      ],
      index(MOSSI, PINOSIIQ),
    );
    expect(rejections).toHaveLength(2);
  });
});

describe('buildRejectionMessage', () => {
  const { rejections } = checkItems([item({ unit_price: 90, qty: 4 })], index(MOSSI));
  const msg = buildRejectionMessage(rejections);

  it('names the sent price and every valid tier', () => {
    expect(msg).toContain('$90.00');
    expect(msg).toContain('$110.00 (1 pza)');
    expect(msg).toContain('$95.00 (desde 2 pzas)');
    expect(msg).toContain('Para qty 4 corresponde: $95.00');
  });

  it('tells the agent to correct itself in chat, not just to retry', () => {
    expect(msg).toContain('avisa al cliente');
  });

  it('never leaks the escape hatch — models learn bypasses from error text', () => {
    expect(msg).not.toContain('price_override');
    expect(msg.toLowerCase()).not.toContain('override');
  });

  it('gives unknown SKUs their own instruction', () => {
    const unknown = checkItems([item({ sku: '99999' })], index(MOSSI)).rejections;
    expect(buildRejectionMessage(unknown)).toContain('no existe en el catálogo');
  });
});

describe('overrideCapExceeded', () => {
  it('allows a whole quote of authorized bundle prices', () => {
    // "un MOSSI y un cloro por $250", granted conversationally in the admin group: every line
    // is an override and the quote is entirely legitimate.
    expect(overrideCapExceeded(2, 2)).toBe(false);
    expect(overrideCapExceeded(5, 5)).toBe(false);
    expect(overrideCapExceeded(6, 10)).toBe(false);
  });

  it('still backstops absurd usage', () => {
    expect(overrideCapExceeded(9, 20)).toBe(true);
  });
});

describe('indexRows', () => {
  it('parses the real response shape', () => {
    const m = indexRows({
      cols: ['sku', 'precio_publico_directo', 'precio_2', 'min_piezas_precio_2'],
      rows: [['12485', 110, 95, '2']],
    });
    expect(m.get('12485')).toHaveLength(1);
    expect(parseTiers(m.get('12485')![0])).toEqual([
      { min: 1, price: 110 },
      { min: 2, price: 95 },
    ]);
  });

  it('groups multiple presentations under one SKU', () => {
    const m = indexRows({
      cols: ['sku', 'presentacion', 'precio_publico_directo'],
      rows: [
        ['12485', 'GARRAFA 10L', 110],
        ['12485', 'CAJA 2 PZAS 10L', 180],
      ],
    });
    expect(m.get('12485')).toHaveLength(2);
  });

  it('treats an unexpected shape as "could not check", not as "no prices"', () => {
    expect(() => indexRows({ error: 'boom' } as never)).toThrow(GuardUnavailable);
  });
});
