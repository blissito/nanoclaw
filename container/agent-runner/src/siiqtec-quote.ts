/**
 * SIIQTEC fast cotización — JSON in, PDF out.
 *
 * Validates strictly (no hallucinated math), generates a fresh MercadoPago link,
 * paginates products if needed, renders the canonical SIIQTEC template,
 * exports via EasyBits, and writes the PDF to /workspace/group/cot-<folio>.pdf.
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
  assertCatalogPrices,
  recordOverrides,
  type GuardMode,
  type OverrideRecord,
  type PriceOverride,
} from './catalog-price-guard.js';

const execFileP = promisify(execFile);

const GROUP_DIR = '/workspace/group';
const ITEMS_PER_PRODUCT_PAGE = 6;
const FOLIO_REGEX = /^\d{6}-\d{3}$/;
const VALID_UNITS = new Set(['PZA', 'GARRAFA', 'KG', 'LT', 'CAJA', 'BOLSA', 'PAR', 'JGO']);

// Emisor branding — overridable per deployment via QUOTE_* env vars so one tool can serve
// sister brands (SIIQTEC, Totequim, ...). Defaults reproduce the SIIQTEC quote byte-for-byte,
// so a deployment that sets nothing is unaffected.
//
// SEED-ON-PULL: these values live in SQLite (per-group container_config.env), NOT in git, so
// they are passed through wholesale by container-runner buildEnvFile(). A sister-brand instance
// must (re)seed QUOTE_* after each pull/clean-install. Totequim (tania) seed:
//   UPDATE registered_groups SET container_config = json_set(container_config, '$.env', json('{
//     "QUOTE_RAZON_SOCIAL":"TOTEQUIM","QUOTE_BRAND_SHORT":"Totequim","QUOTE_WEB":"totequim.com",
//     "QUOTE_CONTACT_LINE":"Tel: 771 701 0389 · 771 364 9372",
//     "QUOTE_FOOTER_CONTACT":"totequim.com · Tel: 771 701 0389"}')) WHERE folder='main';
const BRAND = {
  logoUrl: process.env.QUOTE_LOGO_URL || 'https://easybits-public.fly.storage.tigris.dev/69e19ed033ef9abb7cd5a54b/90R',
  bankLogoUrl: process.env.QUOTE_BANK_LOGO_URL || 'https://easybits-public.fly.storage.tigris.dev/69e19ed033ef9abb7cd5a54b/eHr',
  razonSocial: process.env.QUOTE_RAZON_SOCIAL || 'SIIQTEC SA DE CV',
  rfc: process.env.QUOTE_RFC || 'SII140827F4A',
  addr1: process.env.QUOTE_ADDR_1 || 'ENTRADA SAN ISIDRO 142 · Col: RANCHO SAN ISIDRO C.P.: 42188',
  addr2: process.env.QUOTE_ADDR_2 || 'MINERAL DE LA REFORMA, HIDALGO, MÉXICO',
  contactLine: process.env.QUOTE_CONTACT_LINE || 'Tel: 7712211359 · TOTEQUIM 7717010389 · siiqtec@hotmail.com',
  shortName: process.env.QUOTE_BRAND_SHORT || 'SIIQTEC',
  web: process.env.QUOTE_WEB || 'siiqtec.com.mx',
  footerContact: process.env.QUOTE_FOOTER_CONTACT || 'ventas@siiqtec.com.mx · Tel: 7712211359',
};

// Product photos display at 40px but the PDF engine embeds the full-res source, bloating large
// quotes to 5-9MB and timing out the container. weserv returns a ~1-3KB thumbnail instead.
function thumbUrl(url: string): string {
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=96&h=96&fit=contain&output=jpg&q=72`;
}

export type QuoteInput = {
  folio: string;
  fecha?: string;
  cliente: {
    nombre: string;
    rfc?: string | null;
    email?: string | null;
    tel?: string | null;
    domicilio: string;
    colonia?: string | null;
    ciudad?: string | null;
    negocio?: string | null;
    vendedor?: string | null;
  };
  items: Array<{
    sku: string;
    qty: number;
    unit: string;
    nombre: string;
    unit_price: number;
    imagen_url?: string | null;
    /** Escape hatch for legitimate prices that don't live in the catalog (promo bundles,
     *  freight, services without a SKU). Audited — see catalog-price-guard.ts. */
    price_override?: PriceOverride | null;
  }>;
  envio:
    | { modo: 'ruta_siiqtec'; dia: string; destino: string }
    | { modo: 'paqueteria'; carrier: string; cp: string; dias: string; costo: number };
  include_payment_link?: boolean;
};

export type QuoteResult = {
  path: string;
  folio: string;
  total: number;
  paymentUrl: string | null;
  pages: number;
  /** Whether prices were actually verified against the catalog on this quote. Surfaced so a
   *  silent, permanent 'skipped:no_key' is visible in the transcript instead of invisible. */
  price_check: GuardMode;
  overrides: OverrideRecord[];
  warnings: string[];
};

const AI_DISCLAIMER = 'Esta cotización es generada con IA y puede tener errores';

function fmtMoney(n: number): string {
  return '$ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function todayMx(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

class QuoteError extends Error {
  /** True when the failure is an infra/transient hiccup worth retrying (vs a logical/validation error). */
  readonly transient: boolean;
  constructor(msg: string, transient = false) {
    super(`siiqtec_quote_pdf: ${msg}`);
    this.transient = transient;
  }
}

/** Strict validation. Reject anything that could lead to a wrong quote. */
export function validate(input: QuoteInput): void {
  if (!input || typeof input !== 'object') throw new QuoteError('input must be an object');

  if (!input.folio || !FOLIO_REGEX.test(input.folio)) {
    throw new QuoteError(`folio must match YYMMDD-NNN, got ${JSON.stringify(input.folio)}`);
  }

  if (!input.cliente?.nombre?.trim()) throw new QuoteError('cliente.nombre is required');
  if (!input.cliente?.domicilio?.trim()) {
    throw new QuoteError('cliente.domicilio is required (needed for shipping calculation)');
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new QuoteError('items[] must have at least one product');
  }
  if (input.items.length > 99) throw new QuoteError(`items[] too long: ${input.items.length} > 99`);

  input.items.forEach((it, i) => {
    if (!it.sku?.trim()) throw new QuoteError(`items[${i}].sku is required`);
    if (!it.nombre?.trim()) throw new QuoteError(`items[${i}].nombre is required`);
    if (!Number.isFinite(it.qty) || it.qty <= 0) {
      throw new QuoteError(`items[${i}].qty must be > 0, got ${it.qty}`);
    }
    if (!Number.isFinite(it.unit_price) || it.unit_price < 0) {
      throw new QuoteError(`items[${i}].unit_price must be >= 0, got ${it.unit_price}`);
    }
    if (!VALID_UNITS.has(it.unit)) {
      throw new QuoteError(
        `items[${i}].unit must be one of ${[...VALID_UNITS].join(',')}, got ${JSON.stringify(it.unit)}`,
      );
    }
  });

  const env = input.envio;
  if (!env || typeof env !== 'object') throw new QuoteError('envio is required');
  if (env.modo === 'ruta_siiqtec') {
    if (!env.dia?.trim()) throw new QuoteError("envio.dia is required when modo='ruta_siiqtec'");
    if (!env.destino?.trim()) throw new QuoteError("envio.destino is required when modo='ruta_siiqtec'");
  } else if (env.modo === 'paqueteria') {
    if (!env.carrier?.trim()) throw new QuoteError("envio.carrier is required when modo='paqueteria'");
    if (!Number.isFinite(env.costo) || env.costo < 0) {
      throw new QuoteError(`envio.costo must be >= 0 when modo='paqueteria', got ${env.costo}`);
    }
  } else {
    throw new QuoteError(`envio.modo must be 'ruta_siiqtec' or 'paqueteria', got ${JSON.stringify((env as { modo?: unknown }).modo)}`);
  }
}

/** Compute amounts deterministically (the agent does NOT pass these). */
export function computeTotals(input: QuoteInput): {
  amounts: number[];
  subtotal: number;
  envioCost: number;
  envioLabel: string;
  envioValueText: string;
  envioColor: string;
  total: number;
} {
  const amounts = input.items.map((it) => Math.round(it.qty * it.unit_price * 100) / 100);
  const subtotal = Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100;
  let envioCost = 0;
  let envioLabel = '';
  let envioValueText = '';
  let envioColor = '#16A34A';
  if (input.envio.modo === 'ruta_siiqtec') {
    envioCost = 0;
    envioLabel = `Ruta ${BRAND.shortName} — ${input.envio.destino} · Entrega ${input.envio.dia}`;
    envioValueText = 'GRATIS';
  } else {
    envioCost = Math.round(input.envio.costo * 100) / 100;
    envioLabel = `${input.envio.carrier} · CP ${input.envio.cp} · ${input.envio.dias}`;
    envioValueText = fmtMoney(envioCost);
    envioColor = '#2B3659';
  }
  const total = Math.round((subtotal + envioCost) * 100) / 100;
  return { amounts, subtotal, envioCost, envioLabel, envioValueText, envioColor, total };
}

/** Produce a fresh MercadoPago checkout URL for the total amount. */
async function createMpLink(total: number, folio: string): Promise<string> {
  const desc = `Cotización ${folio}`;
  const { stdout } = await execFileP('/usr/local/bin/mercadopago', ['create-link', String(total), desc]);
  const url = stdout.trim().split(/\s+/).find((s) => s.startsWith('https://'));
  if (!url) throw new QuoteError(`mercadopago CLI returned no URL: ${stdout.slice(0, 200)}`);
  return url;
}

function renderItemRow(
  item: QuoteInput['items'][number],
  amount: number,
): string {
  const imgCell = item.imagen_url
    ? `<img src="${escapeHtml(thumbUrl(item.imagen_url))}" class="w-10 h-10 object-contain" />`
    : `<div class="w-10 h-10 bg-gray-100 rounded flex items-center justify-center"><span class="text-gray-300" style="font-size:8px">S/I</span></div>`;
  return `        <tr class="border-b border-gray-200 align-middle">
          <td class="py-1.5 px-2">${imgCell}<p class="text-gray-400 text-center" style="font-size:7px">${escapeHtml(item.sku)}</p></td>
          <td class="py-1.5 px-2 text-center font-semibold">${item.qty}</td>
          <td class="py-1.5 px-2 text-center">${escapeHtml(item.unit)}</td>
          <td class="py-1.5 px-2 font-medium text-gray-800">${escapeHtml(item.nombre)}</td>
          <td class="py-1.5 px-2 text-right whitespace-nowrap">${fmtMoney(item.unit_price)}</td>
          <td class="py-1.5 px-2 text-right font-semibold whitespace-nowrap">${fmtMoney(amount)}</td>
        </tr>`;
}

export function renderTotalsBlock(
  subtotal: number,
  envioLabel: string,
  envioValueText: string,
  envioColor: string,
  total: number,
): string {
  return `      <tfoot>
        <tr class="border-t border-gray-300 bg-gray-50">
          <td colspan="5" class="py-2 px-2 text-right text-gray-500">Subtotal productos</td>
          <td class="py-2 px-2 text-right font-semibold text-gray-700 whitespace-nowrap">${fmtMoney(subtotal)}</td>
        </tr>
        <tr class="border-t border-gray-200 bg-gray-50">
          <td colspan="5" class="py-2 px-2 text-right text-gray-500">
            <span class="inline-flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${envioColor}" stroke-width="2"><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
              ${escapeHtml(envioLabel)}
            </span>
          </td>
          <td class="py-2 px-2 text-right font-semibold whitespace-nowrap" style="color:${envioColor}">${escapeHtml(envioValueText)}</td>
        </tr>
        <tr class="border-t-2 border-gray-400">
          <td colspan="5" class="py-2.5 px-2 text-right font-black tracking-wide text-sm" style="color:#2B3659">TOTAL</td>
          <td class="py-2.5 px-2 text-right font-black text-lg whitespace-nowrap" style="color:#2B3659">${fmtMoney(total)}</td>
        </tr>
      </tfoot>`;
}

export function renderProductPage(opts: {
  input: QuoteInput;
  pageItems: QuoteInput['items'];
  pageAmounts: number[];
  pageNum: number;
  pageTotal: number;
  isLast: boolean;
  totalsBlock: string | null;
}): string {
  const { input, pageItems, pageAmounts, pageNum, pageTotal, isLast, totalsBlock } = opts;
  const c = input.cliente;
  const dash = (v: string | null | undefined) => (v && v.trim() ? escapeHtml(v) : '—');
  const fechaStr = escapeHtml(input.fecha || todayMx());

  const rows = pageItems.map((it, i) => renderItemRow(it, pageAmounts[i])).join('\n');
  const tfoot = isLast && totalsBlock ? totalsBlock : '';

  return `<section class="w-[8.5in] h-[11in] relative overflow-hidden flex flex-col bg-white font-sans">

  <!-- HEADER -->
  <div class="shrink-0 flex justify-between items-center px-8 pt-3 pb-2 border-b-2 border-gray-800">
    <div class="flex items-center gap-4">
      <img src="${BRAND.logoUrl}" class="h-16 w-auto object-contain" />
      <div class="text-left text-xs text-gray-700">
        <p class="text-sm font-black tracking-wide text-gray-900">${escapeHtml(BRAND.razonSocial)}</p>
        <p class="mt-0.5">RFC: ${escapeHtml(BRAND.rfc)}</p>
        <p>${escapeHtml(BRAND.addr1)}</p>
        <p>${escapeHtml(BRAND.addr2)}</p>
        <p>${escapeHtml(BRAND.contactLine)}</p>
      </div>
    </div>
    <div class="text-right border border-gray-300 rounded px-4 py-2 min-w-36">
      <p class="text-sm font-bold text-gray-700">Cotización</p>
      <p class="text-lg font-black" style="color:#A73547">${escapeHtml(input.folio)}</p>
      <p class="text-xs text-gray-500 mt-1">Fecha</p>
      <p class="text-sm font-semibold text-gray-800">${fechaStr}</p>
      <p class="text-xs text-gray-500 mt-0.5">Moneda: MXN</p>
    </div>
  </div>

  <!-- RECEPTOR -->
  <div class="shrink-0 flex px-8 py-1 border-b border-gray-400 bg-gray-50">
    <div class="w-10 flex items-center justify-center mr-3">
      <p class="text-xs font-bold text-gray-400 tracking-widest" style="writing-mode:vertical-rl;transform:rotate(180deg)">RECEPTOR</p>
    </div>
    <div class="flex-1 grid grid-cols-2 gap-x-8 gap-y-0.5 text-xs py-0.5">
      <div><span class="text-gray-500">Nombre: </span><span class="font-semibold text-gray-800">${dash(c.nombre)}</span></div>
      <div><span class="text-gray-500">R.F.C.: </span><span class="font-semibold text-gray-800">${dash(c.rfc)}</span></div>
      <div><span class="text-gray-500">Email: </span><span class="text-gray-700">${dash(c.email)}</span></div>
      <div><span class="text-gray-500">Tel: </span><span class="text-gray-700">${dash(c.tel)}</span></div>
      <div><span class="text-gray-500">Domicilio: </span><span class="text-gray-700">${dash(c.domicilio)}</span></div>
      <div><span class="text-gray-500">Colonia: </span><span class="text-gray-700">${dash(c.colonia)}</span></div>
      <div><span class="text-gray-500">Ciudad: </span><span class="text-gray-700">${dash(c.ciudad)}</span></div>
      <div><span class="text-gray-500">Vendedor: </span><span class="text-gray-700">${dash(c.vendedor || BRAND.shortName)}</span></div>
    </div>
  </div>

  <!-- TABLA PRODUCTOS -->
  <div class="flex-1 overflow-hidden px-8 py-3">
    <table class="w-full text-xs border-collapse">
      <thead>
        <tr class="text-white" style="background:#2B3659">
          <th class="py-1.5 px-2 text-left w-16">IMG/CLAVE</th>
          <th class="py-1.5 px-2 text-center w-10">CANT</th>
          <th class="py-1.5 px-2 text-center w-14">UNIDAD</th>
          <th class="py-1.5 px-2 text-left">DESCRIPCIÓN</th>
          <th class="py-1.5 px-2 text-right w-24">P. UNIT.</th>
          <th class="py-1.5 px-2 text-right w-24">IMPORTE</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
${tfoot}
    </table>
  </div>

  <!-- FOOTER -->
  <div class="shrink-0 px-8 pb-3 pt-2 border-t border-gray-300">
    <div class="flex justify-between items-end text-xs">
      <div>
        <p class="text-gray-500">Vendedor</p>
        <p class="font-semibold text-gray-800 mt-3 border-t border-gray-400 pt-1 w-40">${dash(c.vendedor || BRAND.shortName)}</p>
      </div>
      <div class="text-right text-gray-500">
        <p class="italic text-gray-400">${AI_DISCLAIMER}</p>
        <p class="mt-0.5">Todos los precios incluyen I.V.A.</p>
        <p class="mt-0.5">Vigencia: 3 días naturales a partir de la fecha de emisión</p>
        <p class="mt-1 font-medium">Página ${pageNum} de ${pageTotal}</p>
      </div>
    </div>
  </div>

</section>`;
}

export function renderDepositPage(opts: {
  folio: string;
  total: number;
  paymentUrl: string | null;
}): string {
  const { folio, total, paymentUrl } = opts;
  const totalStr = fmtMoney(total);
  const urlEnc = paymentUrl ? encodeURIComponent(paymentUrl) : '';
  const mpCard = !paymentUrl ? '' : `

  <!-- CARD PAGO EN LÍNEA — siempre presente -->
  <div class="shrink-0 px-10 pb-4">
    <div class="w-full rounded-xl overflow-hidden" style="border:2px solid #2B3659">
      <div class="text-center py-1.5 text-white text-xs font-black tracking-widest" style="background:#2B3659">
        PAGA EN LÍNEA — SEGURO Y RÁPIDO · MERCADOPAGO
      </div>
      <div class="flex items-center gap-6 px-6 py-4" style="background:#F0F2F8">
        <div class="shrink-0 flex flex-col items-center gap-1">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${urlEnc}" class="w-28 h-28" />
          <p class="text-xs text-center" style="color:#2B3659;font-size:9px">Escanea para pagar</p>
        </div>
        <div class="self-stretch w-px" style="background:#2B3659;opacity:0.2"></div>
        <div class="flex-1">
          <p class="text-sm font-black" style="color:#2B3659">Pago seguro en línea</p>
          <p class="text-xs text-gray-500 mt-1">Cotización: <span class="font-semibold">${escapeHtml(folio)}</span></p>
          <p class="text-xs text-gray-500 mt-0.5">Vigencia: 3 días naturales · Todos los precios incluyen I.V.A.</p>
          <p class="text-xs mt-2 text-gray-400 break-all">${escapeHtml(paymentUrl)}</p>
        </div>
        <div class="shrink-0 flex flex-col items-end gap-3">
          <div class="text-right">
            <p class="text-xs text-gray-500">Total a pagar</p>
            <p class="text-3xl font-black whitespace-nowrap" style="color:#2B3659">${totalStr}</p>
            <p class="text-xs text-gray-400">MXN</p>
          </div>
          <a href="${escapeHtml(paymentUrl)}" style="background:#A73547;color:#ffffff;font-size:12px;font-weight:800;padding:10px 24px;border-radius:8px;text-decoration:none;display:inline-block">💳 Clic para pagar</a>
        </div>
      </div>
    </div>
  </div>`;
  return `<section class="w-[8.5in] h-[11in] relative overflow-hidden flex flex-col bg-white font-sans">
  <div class="shrink-0 h-2 w-full" style="background:#2B3659"></div>
  <div class="shrink-0 px-10 py-6">
    <div class="flex gap-0 border border-gray-300">
      <div class="flex border-r border-gray-300" style="min-width:280px;max-width:280px">
        <div class="flex items-center justify-center bg-gray-100 border-r border-gray-300 px-1">
          <p class="text-xs text-gray-500 font-bold tracking-widest" style="writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap">DATOS DE LA EMPRESA</p>
        </div>
        <div class="flex-1 flex flex-col items-center justify-center py-6 px-6 gap-3">
          <img src="${BRAND.logoUrl}" class="h-36 w-auto object-contain" />
          <table class="w-full text-xs border-collapse">
            <tr><td class="border border-gray-300 px-3 py-1 bg-gray-50 text-center text-gray-500">Razón Social</td></tr>
            <tr><td class="border border-gray-300 px-3 py-2 text-center font-bold text-gray-800">${escapeHtml(BRAND.razonSocial)}</td></tr>
          </table>
        </div>
      </div>
      <div class="flex-1 flex flex-col">
        <div class="shrink-0 border-b border-gray-300 text-center py-2">
          <p class="text-base font-black tracking-widest text-gray-800">FICHA DE DEPÓSITO</p>
        </div>
        <div class="flex border-b border-gray-300">
          <div class="flex items-center justify-center bg-gray-100 border-r border-gray-300 px-1">
            <p class="text-xs text-gray-500 font-bold tracking-widest" style="writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap">DATOS BANCARIOS</p>
          </div>
          <div class="flex-1 flex items-center gap-4 px-4 py-3">
            <img src="${BRAND.bankLogoUrl}" class="h-10 w-auto object-contain flex-shrink-0" />
            <table class="flex-1 text-xs border-collapse">
              <thead><tr>
                <th class="border border-gray-300 px-4 py-1 bg-gray-50 text-gray-600 font-semibold">Cuenta</th>
                <th class="border border-gray-300 px-4 py-1 bg-gray-50 text-gray-600 font-semibold">Sucursal</th>
              </tr></thead>
              <tbody>
                <tr>
                  <td class="border border-gray-300 px-4 py-2 text-center font-bold text-gray-800 text-sm">7830037</td>
                  <td class="border border-gray-300 px-4 py-2 text-center font-bold text-gray-800 text-sm">7008</td>
                </tr>
                <tr><td colspan="2" class="border border-gray-300 px-4 py-1 text-center bg-gray-50 text-gray-600 text-xs font-semibold">CLABE</td></tr>
                <tr><td colspan="2" class="border border-gray-300 px-4 py-2 text-center font-bold text-gray-800 tracking-widest">002290700878300370</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="flex">
          <div class="flex items-center justify-center bg-gray-100 border-r border-gray-300 px-1">
            <p class="text-xs text-gray-500 font-bold tracking-widest" style="writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap">DATOS DE PAGO</p>
          </div>
          <div class="flex-1">
            <table class="w-full text-xs border-collapse">
              <thead><tr>
                <th class="border border-gray-300 px-4 py-1 bg-gray-50 text-gray-600 font-semibold">Concepto</th>
                <th class="border border-gray-300 px-4 py-1 bg-gray-50 text-gray-600 font-semibold w-40">TOTAL</th>
              </tr></thead>
              <tbody><tr>
                <td class="border border-gray-300 px-4 py-3 text-center text-gray-800">Cotización No. ${escapeHtml(folio)}</td>
                <td class="border border-gray-300 px-4 py-3 text-center font-black text-gray-800 text-sm whitespace-nowrap">${totalStr} MXN</td>
              </tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

${mpCard}

  <div class="shrink-0 w-full px-10 py-3 border-t border-gray-200 mt-auto text-xs text-gray-400">
    <div class="flex justify-between">
      <p>${escapeHtml(BRAND.shortName)} · ${escapeHtml(BRAND.web)}</p>
      <p>${escapeHtml(BRAND.footerContact)}</p>
    </div>
    <p class="text-right italic mt-0.5">${AI_DISCLAIMER}</p>
  </div>
</section>`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Classify a JSON-RPC error object from easybits-mcp as transient (worth retrying)
 * or fatal. Internal server errors (-32603) and network/5xx-flavoured messages are
 * transient; validation/method errors (e.g. -32602) are fatal — retrying won't help.
 */
function isTransientMcpError(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === -32603) return true;
  return /\b5\d\d\b|timeout|etimedout|econnreset|econnrefused|socket hang up|overloaded|unavailable|temporar/i.test(
    e.message || '',
  );
}

/**
 * Call easybits-mcp with bounded retries on transient failures. The heavy
 * `export_document` render is intermittently flaky under load (observed 2026-07-06:
 * proxy dropping the connection → "no result"); a brief blip shouldn't cost the
 * customer their quote. Fatal errors (bad args) fail on the first attempt.
 * Exponential backoff with jitter; each retry is logged to stderr for journalctl.
 */
async function easybitsCallResilient(
  method: string,
  params: unknown,
  attempts = 3,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await easybitsCall(method, params);
    } catch (e) {
      lastErr = e;
      const transient = e instanceof QuoteError && e.transient;
      if (!transient || attempt === attempts) break;
      const delay = Math.min(4000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      console.error(
        `[siiqtec_quote_pdf] ${method} transient failure (attempt ${attempt}/${attempts}): ${
          (e as Error).message
        } — retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Talk to easybits-mcp via stdio JSON-RPC. Spawns a fresh subprocess per call. */
async function easybitsCall(method: string, params: unknown): Promise<unknown> {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'siiqtec-quote', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: method, arguments: params } },
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('easybits-mcp', [], { env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new QuoteError(`easybits-mcp ${method} timed out after 60s`, true));
    }, 60000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new QuoteError(`easybits-mcp spawn failed: ${e.message}`, true));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.split('\n').filter(Boolean);
      let last: string | undefined;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.id === 2) last = line;
        } catch {
          /* skip non-JSON */
        }
      }
      if (!last) {
        // Subprocess closed without emitting an id:2 response — proxy dropped the
        // connection or the server 5xx'd. This is the observed transient failure mode.
        reject(new QuoteError(`easybits-mcp ${method}: no result. stderr=${stderr.slice(0, 300)}`, true));
        return;
      }
      try {
        const resp = JSON.parse(last);
        if (resp.error) {
          reject(new QuoteError(`easybits-mcp ${method} error: ${JSON.stringify(resp.error)}`, isTransientMcpError(resp.error)));
          return;
        }
        const content = resp.result?.content || [];
        const text = content.map((c: { text?: string }) => c.text || '').join('');
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      } catch (e) {
        // A partial/truncated line means the stream was cut mid-response — transient.
        reject(new QuoteError(`easybits-mcp ${method}: parse failed: ${(e as Error).message}`, true));
      }
    });
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    child.stdin.end();
  });
}

/** HEAD-check an image URL. Returns true only on 2xx with image/* content-type. */
async function imageOk(url: string, timeoutMs = 3000): Promise<boolean> {
  const lib = url.startsWith('https://') ? await import('https') : await import('http');
  return new Promise((resolve) => {
    const req = (lib as typeof import('https')).request(
      url,
      { method: 'HEAD', timeout: timeoutMs },
      (res) => {
        const code = res.statusCode || 0;
        const ct = String(res.headers['content-type'] || '');
        resolve(code >= 200 && code < 300 && ct.startsWith('image/'));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Replace any unreachable item.imagen_url with null so the renderer uses the S/I placeholder. */
async function pruneBrokenImages(items: QuoteInput['items']): Promise<void> {
  const checks = items.map(async (it) => {
    if (!it.imagen_url) return;
    const ok = await imageOk(it.imagen_url).catch(() => false);
    if (!ok) it.imagen_url = null;
  });
  await Promise.all(checks);
}

async function downloadPdf(url: string, dest: string): Promise<number> {
  const { default: https } = await import('https');
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new QuoteError(`PDF download HTTP ${res.statusCode}`));
          return;
        }
        let bytes = 0;
        res.on('data', (chunk) => (bytes += chunk.length));
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(bytes);
        });
      })
      .on('error', (e) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(new QuoteError(`PDF download failed: ${e.message}`));
      });
  });
}

export async function runSiiqtecQuotePdf(input: QuoteInput): Promise<QuoteResult> {
  validate(input);
  // Before computeTotals: totals are derived from unit_price, so validating afterwards would
  // just be computing on top of a wrong number. Kept out of validate() so that stays sync+pure.
  const guard = await assertCatalogPrices(input.items);
  recordOverrides(input.folio, guard.overrides, GROUP_DIR);
  await pruneBrokenImages(input.items);
  const totals = computeTotals(input);

  const paymentUrl = input.include_payment_link
    ? await createMpLink(totals.total, input.folio)
    : null;

  const chunks: QuoteInput['items'][] = [];
  const amountChunks: number[][] = [];
  for (let i = 0; i < input.items.length; i += ITEMS_PER_PRODUCT_PAGE) {
    chunks.push(input.items.slice(i, i + ITEMS_PER_PRODUCT_PAGE));
    amountChunks.push(totals.amounts.slice(i, i + ITEMS_PER_PRODUCT_PAGE));
  }
  const totalPages = chunks.length + 1;

  const totalsBlock = renderTotalsBlock(
    totals.subtotal,
    totals.envioLabel,
    totals.envioValueText,
    totals.envioColor,
    totals.total,
  );

  const sections: Array<{ id: string; order: number; name: string; html: string }> = [];
  chunks.forEach((pageItems, idx) => {
    const isLast = idx === chunks.length - 1;
    sections.push({
      id: `p${idx + 1}`,
      order: idx,
      name: `Cotización ${idx + 1}/${chunks.length}`,
      html: renderProductPage({
        input,
        pageItems,
        pageAmounts: amountChunks[idx],
        pageNum: idx + 1,
        pageTotal: totalPages,
        isLast,
        totalsBlock: isLast ? totalsBlock : null,
      }),
    });
  });
  sections.push({
    id: `p${chunks.length + 1}`,
    order: chunks.length,
    name: 'Ficha de depósito',
    html: renderDepositPage({ folio: input.folio, total: totals.total, paymentUrl }),
  });

  const created = (await easybitsCallResilient('create_document', {
    name: `COT-${input.folio} — ${input.cliente.nombre}`,
    sections,
  })) as { id?: string };
  if (!created?.id) throw new QuoteError('create_document returned no id');

  // Retries land on the SAME documentId — no re-render on our side.
  const exported = (await easybitsCallResilient('export_document', {
    documentId: created.id,
    as: 'pdf',
  })) as {
    file?: { url?: string };
  };
  const url = exported?.file?.url;
  if (!url) throw new QuoteError('export_document returned no file.url');

  fs.mkdirSync(GROUP_DIR, { recursive: true });
  const dest = path.join(GROUP_DIR, `cot-${input.folio}.pdf`);
  await downloadPdf(url, dest);

  return {
    path: dest,
    folio: input.folio,
    total: totals.total,
    paymentUrl,
    pages: totalPages,
    price_check: guard.mode,
    overrides: guard.overrides,
    warnings: guard.warnings,
  };
}
