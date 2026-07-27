/**
 * Catalog price guard — stops the model from being the source of truth for money.
 *
 * Incident that motivated this (sofi-0, 2026-07-27): a WhatsApp session had been alive
 * since 2026-05-14. The only full MOSSI catalog query in it ran on day one, when the price
 * genuinely was $100/$90. Prices rose to $110/$95 in June. Two and a half months later the
 * agent quoted a customer $90/u straight out of its own context, never re-querying. The tell:
 * every aroma got the stale price EXCEPT the one SKU it happened to re-query in June.
 *
 * So: `unit_price` arrives from the model and is checked against the live catalog before any
 * money is rendered. A price that doesn't exist in the catalog can't reach a PDF.
 *
 * Design notes worth keeping:
 *  - This file is byte-identical across sofi-0 / tania / siiqtec-mkt-0, whose copies of
 *    siiqtec-quote.ts have diverged. Everything droplet-specific goes through env vars, so the
 *    per-box diff stays at "one import + one await".
 *  - Fail OPEN when the catalog is unreachable. The catalog and the PDF renderer are the same
 *    host — if it's down, the quote fails a few seconds later anyway, so failing closed here
 *    buys nothing and adds a novel way to block a sale during a blip.
 *  - Fail CLOSED on an unknown SKU. That one gets printed on the PDF.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_CATALOG_DB_ID = '69fd58e5fb8904ba077f0fba';
const EASYBITS_API_BASE = 'https://www.easybits.cloud/api/v2';
const QUERY_TIMEOUT_MS = 6000;
const RETRY_DELAY_MS = 400;

/** Half a centavo. Catalog prices are whole pesos or 2 decimals, so this catches $95 vs $95.01
 *  while absorbing float noise from the JSON round-trip. Deliberately NOT a percentage: 1% of
 *  $110 is $1.10, wide enough to wave through a genuinely wrong price. */
const PRICE_EPSILON = 0.005;

/**
 * Backstop against the escape hatch being used as a blanket bypass.
 *
 * Deliberately generous. Promos here are granted conversationally by the team in the admin group
 * ("un MOSSI y un cloro por $250"), so a quote where EVERY line is an authorized bundle price is
 * a normal Tuesday, not an anomaly — a ratio rule would reject real sales. This is only here to
 * catch absurd usage; the real controls are that the rejection message never names the hatch,
 * and that every override is logged for review.
 */
const MAX_OVERRIDES = Number(process.env.QUOTE_MAX_OVERRIDES) || 8;

export type OverrideKind =
  | 'promocion'
  | 'precio_especial_autorizado'
  | 'servicio_sin_sku'
  | 'producto_no_catalogado';

export type PriceOverride = { kind: OverrideKind; reason: string };

export type GuardItem = {
  sku: string;
  qty: number;
  nombre: string;
  unit_price: number;
  price_override?: PriceOverride | null;
};

export type GuardMode = 'enforced' | 'dry-run' | 'skipped:no_key' | 'skipped:unreachable' | 'off';

export type OverrideRecord = {
  sku: string;
  nombre: string;
  qty: number;
  unit_price: number;
  kind: OverrideKind;
  reason: string;
  /** Catalog tiers for this SKU when we happen to know them — the delta is the audit signal. */
  catalog?: string;
};

export type GuardResult = {
  mode: GuardMode;
  overrides: OverrideRecord[];
  warnings: string[];
};

export type CatalogRow = {
  sku: string;
  producto_id: string | null;
  nombre: string | null;
  presentacion: string | null;
  precio_publico_directo: unknown;
  precio_2: unknown;
  min_piezas_precio_2: unknown;
  precio_3: unknown;
  min_piezas_precio_3: unknown;
};

export type Tier = { min: number; price: number };

/** Thrown when a price is rejected. The message is written FOR THE AGENT — it is what lands in
 *  the tool result, so it has to say what to do next, not just what went wrong. */
export class QuotePriceError extends Error {
  readonly kind = 'price_rejected';
  constructor(message: string) {
    super(message);
    this.name = 'QuotePriceError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no IO — these are what the unit tests exercise)
// ---------------------------------------------------------------------------

/** Coerce a catalog cell to a number. The API returns min_piezas as strings ("2"), prices
 *  sometimes as null, and occasionally as an empty string. Anything unparseable is null, never
 *  NaN — a NaN leaking into a tier comparison would silently accept every price. */
export function num(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  const s = String(x).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Extract the price ladder from one catalog row, dropping null/empty/zero tiers. */
export function parseTiers(row: CatalogRow): Tier[] {
  const out: Tier[] = [];
  const direct = num(row.precio_publico_directo);
  if (direct !== null && direct > 0) out.push({ min: 1, price: direct });

  const pairs: Array<[unknown, unknown]> = [
    [row.precio_2, row.min_piezas_precio_2],
    [row.precio_3, row.min_piezas_precio_3],
  ];
  for (const [rawPrice, rawMin] of pairs) {
    const price = num(rawPrice);
    const min = num(rawMin);
    if (price !== null && price > 0 && min !== null && min >= 1) out.push({ min, price });
  }
  return out.sort((a, b) => a.min - b.min);
}

/** The tier that applies at this quantity: the highest bracket the qty actually reaches. */
export function expectedTier(tiers: Tier[], qty: number): Tier | null {
  let best: Tier | null = null;
  for (const t of tiers) if (qty >= t.min && (best === null || t.min > best.min)) best = t;
  return best ?? tiers[0] ?? null;
}

export function pricesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < PRICE_EPSILON;
}

function fmt(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "$110.00 (1 pza) · $95.00 (desde 2 pzas)" */
export function describeTiers(tiers: Tier[]): string {
  if (!tiers.length) return 'sin precio en catálogo';
  return tiers
    .map((t) => (t.min <= 1 ? `${fmt(t.price)} (1 pza)` : `${fmt(t.price)} (desde ${t.min} pzas)`))
    .join(' · ');
}

export type Rejection =
  | { type: 'unknown_sku'; sku: string; nombre: string }
  | {
      type: 'price_mismatch' | 'insufficient_qty';
      sku: string;
      /** Catalog truth, not what the agent claimed — a wrong product name shows up in logs too. */
      nombre: string;
      qty: number;
      sent: number;
      rows: Array<{ presentacion: string; tiers: Tier[] }>;
      expected: number | null;
      /** For 'insufficient_qty': the volume the sent price actually requires. */
      requiresQty?: number;
    };

/**
 * Decide, from catalog rows already in hand, which items are bad.
 *
 * SKU→row resolution: the tool's item schema carries `sku` + `unit` but not `presentacion`, so
 * one SKU can map to several rows (GARRAFA 10L and CAJA 2 PZAS 10L at different prices). We
 * accept the price if it matches a tier the QUANTITY ACTUALLY QUALIFIES FOR, on any row.
 *
 * The qualification part is not optional, and testing against the live catalog is what proved
 * it. An earlier version accepted any tier price on any row, on the theory that a price present
 * in the catalog can't be a fossil. It let the exact incident through: MOSSI 12485 turns out to
 * have a third tier at $90 from 10 pieces, so the $90 quoted on a 4-piece order looked valid.
 * Charging a volume price without the volume is the same failure with a different shape — the
 * customer is quoted a number the catalog does not support for their order.
 *
 * Overcharging (list price where a bulk tier was available) stays a warning, not a rejection:
 * it's a real catalog price the customer does qualify for, and the prompt already covers it.
 */
export function checkItems(
  items: GuardItem[],
  rowsBySku: Map<string, CatalogRow[]>,
): { rejections: Rejection[]; warnings: string[] } {
  const rejections: Rejection[] = [];
  const warnings: string[] = [];

  for (const item of items) {
    if (item.price_override) continue;

    const rows = rowsBySku.get(item.sku) ?? [];
    if (!rows.length) {
      rejections.push({ type: 'unknown_sku', sku: item.sku, nombre: item.nombre });
      continue;
    }

    const perRow = rows.map((r) => ({
      presentacion: r.presentacion || '(sin presentación)',
      tiers: parseTiers(r),
      nombre: r.nombre || item.nombre,
    }));

    // Only tiers the order actually reaches count as a match.
    const matched = perRow.find((r) =>
      r.tiers.some((t) => t.min <= item.qty && pricesEqual(t.price, item.unit_price)),
    );

    if (!matched) {
      // Pick the row with the most tiers for the "corresponde" hint — best guess at the main
      // presentation when we can't tell which one the agent meant.
      const richest = perRow.reduce((a, b) => (b.tiers.length > a.tiers.length ? b : a));
      const exp = expectedTier(richest.tiers, item.qty);

      // Did the price exist, but only above this quantity? That's a distinct mistake and
      // deserves its own wording: the agent gave a bulk price without the bulk.
      let requiresQty: number | undefined;
      for (const r of perRow) {
        for (const t of r.tiers) {
          if (pricesEqual(t.price, item.unit_price) && t.min > item.qty) {
            requiresQty = requiresQty === undefined ? t.min : Math.min(requiresQty, t.min);
          }
        }
      }

      rejections.push({
        type: requiresQty === undefined ? 'price_mismatch' : 'insufficient_qty',
        sku: item.sku,
        nombre: richest.nombre,
        qty: item.qty,
        sent: item.unit_price,
        rows: perRow.map((r) => ({ presentacion: r.presentacion, tiers: r.tiers })),
        expected: exp ? exp.price : null,
        ...(requiresQty !== undefined && { requiresQty }),
      });
      continue;
    }

    // Price exists in the catalog but may be the wrong bracket for this quantity. Warn, don't block.
    const exp = expectedTier(matched.tiers, item.qty);
    if (exp && !pricesEqual(exp.price, item.unit_price)) {
      warnings.push(
        `SKU ${item.sku} (${matched.nombre}): cotizaste ${fmt(item.unit_price)} para qty ${item.qty}; ` +
          `el escalón que corresponde es ${fmt(exp.price)}. Revisa si aplica mayoreo.`,
      );
    }
  }

  return { rejections, warnings };
}

/**
 * Build the message the agent sees.
 *
 * Two properties here are load-bearing:
 *  1. Every bad item goes in ONE message. Rejecting one at a time burns 3-4 tool round-trips
 *     per quote and eventually the agent gives up and apologizes to the customer.
 *  2. It never mentions price_override. Models pick up bypasses from error text far faster than
 *     from a system prompt; the escape hatch is taught only where we control the framing.
 */
export function buildRejectionMessage(rejections: Rejection[]): string {
  const lines: string[] = ['PRECIO RECHAZADO — el precio enviado no coincide con el catálogo vigente.', ''];

  for (const r of rejections) {
    if (r.type === 'unknown_sku') {
      lines.push(`• SKU ${r.sku} — "${r.nombre}"`);
      lines.push('  Este SKU no existe en el catálogo. Verifícalo con db_query antes de cotizar.');
      lines.push('');
      continue;
    }
    lines.push(`• SKU ${r.sku} — ${r.nombre}`);
    lines.push(`  Enviaste: ${fmt(r.sent)} · qty ${r.qty}`);
    if (r.type === 'insufficient_qty') {
      lines.push(
        `  ${fmt(r.sent)} es precio de mayoreo desde ${r.requiresQty} pzas — el cliente pide ${r.qty}.`,
      );
    }
    lines.push('  Precios vigentes en catálogo:');
    for (const row of r.rows) lines.push(`    - ${row.presentacion}: ${describeTiers(row.tiers)}`);
    if (r.expected !== null) lines.push(`  Para qty ${r.qty} corresponde: ${fmt(r.expected)}`);
    lines.push('');
  }

  // Tailor the closing instruction: telling the agent to "use the prices above" when the only
  // problem was a nonexistent SKU sends it looking for prices that aren't there.
  if (rejections.every((r) => r.type === 'unknown_sku')) {
    lines.push(
      'No se generó ningún PDF. Busca el SKU correcto en el catálogo con db_query y vuelve a',
      'llamar la tool.',
    );
  } else {
    lines.push(
      'No se generó ningún PDF. Los precios que recuerdas de mensajes anteriores pueden estar',
      'desactualizados: el catálogo cambia. Vuelve a llamar la tool con los precios de arriba, y',
      'ANTES avisa al cliente en el chat que corriges el precio (ej: "Una corrección: MOSSI 10L',
      'quedó en $95 c/u, no $90").',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read at call time, not module load, so flipping dry-run → enforce is an env change and a
 *  service restart — no container rebuild. */
export function currentMode(): 'enforce' | 'dry-run' | 'off' {
  const raw = (process.env.QUOTE_GUARD_MODE || '').trim().toLowerCase();
  if (raw === 'enforce') return 'enforce';
  if (raw === 'off') return 'off';
  return 'dry-run';
}

function catalogDbId(): string {
  return (process.env.QUOTE_CATALOG_DB_ID || '').trim() || DEFAULT_CATALOG_DB_ID;
}

/** One query for every SKU in the quote. N queries per quote would be N round-trips on the
 *  critical path of a customer conversation. */
export async function fetchCatalogRows(skus: string[]): Promise<Map<string, CatalogRow[]>> {
  const key = (process.env.EASYBITS_API_KEY || '').trim();
  if (!key) throw new GuardUnavailable('EASYBITS_API_KEY no está definida');
  if (!skus.length) return new Map();

  const placeholders = skus.map(() => '?').join(',');
  const sql =
    'SELECT sku, producto_id, nombre, presentacion, precio_publico_directo, ' +
    'precio_2, min_piezas_precio_2, precio_3, min_piezas_precio_3 ' +
    `FROM catalogo WHERE sku IN (${placeholders})`;

  const body = JSON.stringify({ sql, args: skus });
  const url = `${EASYBITS_API_BASE}/databases/${catalogDbId()}/query`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { cols?: unknown; rows?: unknown };
      return indexRows(json);
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await sleep(RETRY_DELAY_MS);
    }
  }
  throw new GuardUnavailable(`catálogo inalcanzable: ${(lastErr as Error)?.message || lastErr}`);
}

/** Signals "we could not check", which is always fail-open. Distinct from QuotePriceError,
 *  which means "we checked and it's wrong". */
export class GuardUnavailable extends Error {}

export function indexRows(json: { cols?: unknown; rows?: unknown }): Map<string, CatalogRow[]> {
  const cols = json?.cols;
  const rows = json?.rows;
  if (!Array.isArray(cols) || !Array.isArray(rows)) {
    throw new GuardUnavailable('respuesta del catálogo con forma inesperada');
  }
  const idx = (name: string): number => cols.indexOf(name);
  const out = new Map<string, CatalogRow[]>();
  for (const raw of rows) {
    if (!Array.isArray(raw)) continue;
    const at = (name: string): unknown => {
      const i = idx(name);
      return i >= 0 ? raw[i] : null;
    };
    const sku = String(at('sku') ?? '').trim();
    if (!sku) continue;
    const row: CatalogRow = {
      sku,
      producto_id: (at('producto_id') as string) ?? null,
      nombre: (at('nombre') as string) ?? null,
      presentacion: (at('presentacion') as string) ?? null,
      precio_publico_directo: at('precio_publico_directo'),
      precio_2: at('precio_2'),
      min_piezas_precio_2: at('min_piezas_precio_2'),
      precio_3: at('precio_3'),
      min_piezas_precio_3: at('min_piezas_precio_3'),
    };
    const list = out.get(sku);
    if (list) list.push(row);
    else out.set(sku, [row]);
  }
  return out;
}

/**
 * Absolute backstop only — no ratio rule.
 *
 * An earlier version rejected when more than half the lines were overridden. That was wrong for
 * this business: the team authorizes bundle prices by chatting with the agent in the admin group
 * ("un MOSSI y un cloro por $250"), which produces a two-line quote with both lines overridden.
 * Every such sale would have been blocked. Auditing catches abuse; a ratio only catches revenue.
 */
export function overrideCapExceeded(overrideCount: number, _itemCount: number): boolean {
  return overrideCount > MAX_OVERRIDES;
}

/**
 * Persist override usage. Two sinks on purpose: stderr JSON for grep/journalctl, and a plain
 * line in the group dir for the weekly human read. No amount of design substitutes for someone
 * looking at this once a week — if `promocion` shows up on a plain lavender line, the guardrail
 * has leaked and the cap needs tightening.
 *
 * Never throws: an unwritable log must not cost the customer their quote.
 */
export function recordOverrides(folio: string, overrides: OverrideRecord[], groupDir: string): void {
  if (!overrides.length) return;
  const ts = new Date().toISOString();
  for (const o of overrides) {
    console.error(
      JSON.stringify({
        tag: 'quote-price-override',
        ts,
        folio,
        sku: o.sku,
        nombre: o.nombre,
        qty: o.qty,
        unit_price: o.unit_price,
        kind: o.kind,
        reason: o.reason,
        catalog: o.catalog ?? null,
      }),
    );
  }
  try {
    const lines = overrides
      .map(
        (o) =>
          `${ts}  ${folio}  ${o.sku}  ${o.nombre}  qty=${o.qty}  ${fmt(o.unit_price)}  ` +
          `${o.kind}  "${o.reason}"${o.catalog ? `  (catálogo: ${o.catalog})` : ''}`,
      )
      .join('\n');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.appendFileSync(path.join(groupDir, 'quote-overrides.log'), lines + '\n');
  } catch (e) {
    console.error(`[quote-guard] no se pudo escribir quote-overrides.log: ${(e as Error).message}`);
  }
}

/**
 * Validate every item's unit_price against the live catalog.
 *
 * Throws QuotePriceError when a price is wrong (in enforce mode). Never throws for
 * infrastructure problems — those come back as a `skipped:*` mode plus a warning, because a
 * catalog blip must not block a sale.
 */
export async function assertCatalogPrices(items: GuardItem[]): Promise<GuardResult> {
  const mode = currentMode();
  const overrides: OverrideRecord[] = items
    .filter((it) => it.price_override)
    .map((it) => ({
      sku: it.sku,
      nombre: it.nombre,
      qty: it.qty,
      unit_price: it.unit_price,
      kind: it.price_override!.kind,
      reason: it.price_override!.reason,
    }));

  if (mode === 'off') return { mode: 'off', overrides, warnings: [] };

  if (overrideCapExceeded(overrides.length, items.length)) {
    const msg =
      `Demasiados price_override (${overrides.length} de ${items.length} ítems). Los overrides son ` +
      'para promociones puntuales y servicios sin SKU, no para cotizaciones completas. ' +
      'Consulta el catálogo con db_query y cotiza con los precios vigentes.';
    if (mode === 'enforce') throw new QuotePriceError(msg);
    console.error(`[quote-guard] WOULD REJECT (override cap): ${overrides.length}/${items.length}`);
    return { mode: 'dry-run', overrides, warnings: [msg] };
  }

  const toCheck = items.filter((it) => !it.price_override);
  const skus = [...new Set(toCheck.map((it) => it.sku.trim()).filter(Boolean))];

  let rowsBySku: Map<string, CatalogRow[]>;
  try {
    rowsBySku = await fetchCatalogRows(skus);
  } catch (e) {
    if (e instanceof GuardUnavailable) {
      const noKey = /EASYBITS_API_KEY/.test(e.message);
      console.error(`[quote-guard] verificación omitida — ${e.message}`);
      return {
        mode: noKey ? 'skipped:no_key' : 'skipped:unreachable',
        overrides,
        warnings: [`No se pudo verificar precios contra el catálogo (${e.message}).`],
      };
    }
    throw e;
  }

  const { rejections, warnings } = checkItems(toCheck, rowsBySku);

  // Attach catalog tiers to override records — the delta between what was charged and what the
  // catalog says is the thing a human reviewing the log actually looks at.
  for (const rec of overrides) {
    const rows = rowsBySku.get(rec.sku);
    if (rows?.length) rec.catalog = describeTiers(parseTiers(rows[0]));
  }

  if (rejections.length) {
    const message = buildRejectionMessage(rejections);
    if (mode === 'enforce') throw new QuotePriceError(message);
    for (const r of rejections) {
      if (r.type === 'unknown_sku') {
        console.error(`[quote-guard] WOULD REJECT sku=${r.sku} reason=unknown_sku`);
      } else {
        console.error(
          `[quote-guard] WOULD REJECT sku=${r.sku} sent=${r.sent} expected=${r.expected ?? 'n/a'} qty=${r.qty}`,
        );
      }
    }
    return { mode: 'dry-run', overrides, warnings: [...warnings, message] };
  }

  for (const w of warnings) console.error(`[quote-guard] warning: ${w}`);
  return { mode: mode === 'enforce' ? 'enforced' : 'dry-run', overrides, warnings };
}
