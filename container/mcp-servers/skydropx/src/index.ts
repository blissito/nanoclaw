#!/usr/bin/env node
/**
 * Skydropx PRO MCP Server — stdio transport.
 * Tools for shipping in Mexico: quote rates, create shipments, track, cancel.
 *
 * Env:
 *   SKYDROPX_CLIENT_ID      — OAuth2 client_id (Conexiones > API in Skydropx dashboard)
 *   SKYDROPX_CLIENT_SECRET  — OAuth2 client_secret
 *   SKYDROPX_BASE_URL       — https://pro.skydropx.com (prod) or https://sb-pro.skydropx.com (sandbox)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { skydropx, toToolResult } from './api.js';

const server = new McpServer({ name: 'skydropx', version: '1.0.0' });

// ─── shared schemas ────────────────────────────────────────────────────────

const addressSchema = z.object({
  area_level1: z.string().describe('Estado/entidad, e.g. "Ciudad de México", "Nuevo León"'),
  area_level2: z.string().describe('Municipio/delegación, e.g. "Cuauhtémoc", "Monterrey"'),
  area_level3: z.string().optional().describe('Colonia (opcional pero recomendado para mejor cotización)'),
  country_code: z.string().length(2).describe('ISO-2, e.g. "MX", "US"'),
  postal_code: z.string().describe('Código postal, e.g. "06600"'),
  street1: z.string().describe('Calle (sin número)'),
  street_number: z.string().optional().describe('Número exterior'),
  apartment_number: z.string().optional().describe('Número interior / depto'),
  reference: z.string().optional().describe('Entre calles o referencia adicional para el repartidor'),
  name: z.string().describe('Nombre del contacto en esta dirección'),
  company: z.string().optional(),
  phone: z.string().describe('Teléfono con código de país, e.g. "+5215512345678"'),
  email: z.string().describe('Email del contacto (requerido por Skydropx)'),
  rfc: z.string().optional().describe('RFC (solo si el cliente lo requiere para facturación)'),
});

const parcelSchema = z.object({
  weight: z.number().positive().describe('Peso en kg'),
  length: z.number().positive().describe('Largo en cm'),
  width: z.number().positive().describe('Ancho en cm'),
  height: z.number().positive().describe('Alto en cm'),
});

// ─── TOOLS ──────────────────────────────────────────────────────────────────

server.tool(
  'skydropx_quote',
  'Cotiza tarifas de envío entre dos direcciones para un paquete. Skydropx procesa rates de forma asíncrona; este tool internamente espera hasta que la cotización esté completa (timeout 12s) y devuelve los rates con precio. Cada rate tiene id, provider_name, provider_service_name, total, days. Usa el rate.id elegido como input para skydropx_create_shipment. Cotizaciones válidas 24h.',
  {
    address_from: addressSchema.describe('Dirección de origen'),
    address_to: addressSchema.describe('Dirección de destino'),
    parcels: z.array(parcelSchema).min(1).describe('Paquetes a enviar (mínimo 1)'),
  },
  async ({ address_from, address_to, parcels }) => {
    const payload = {
      quotation: {
        address_from,
        address_to,
        parcel: parcels[0],
        ...(parcels.length > 1 ? { parcels } : {}),
      },
    };
    const initial = await skydropx.post<{ id: string; is_completed: boolean }>('/api/v1/quotations', payload);
    if (!initial.ok) return toToolResult(initial);

    // Poll until completed or timeout (12s total: 8 attempts * 1.5s)
    const quoteId = initial.data.id;
    if (initial.data.is_completed) return toToolResult(initial);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const refreshed = await skydropx.get<{ is_completed: boolean }>(`/api/v1/quotations/${quoteId}`);
      if (!refreshed.ok) return toToolResult(refreshed);
      if (refreshed.data.is_completed) return toToolResult(refreshed);
    }
    // Timeout: return last partial state with hint
    const last = await skydropx.get(`/api/v1/quotations/${quoteId}`);
    return toToolResult(last);
  },
);

server.tool(
  'skydropx_create_shipment',
  'Crea un envío real usando un rate_id de una cotización previa. ⚠️ COSTOS REALES: confirma con el user antes de invocar. Devuelve shipment_id, tracking_number, carrier_name y label_url (PDF de la guía).',
  {
    rate_id: z.string().describe('id del rate elegido (de la respuesta de skydropx_quote)'),
    address_from: addressSchema,
    address_to: addressSchema,
    parcels: z.array(parcelSchema).min(1),
  },
  async ({ rate_id, address_from, address_to, parcels }) => {
    const payload = {
      shipment: {
        rate_id,
        address_from,
        address_to,
        parcel: parcels[0],
        ...(parcels.length > 1 ? { parcels } : {}),
      },
    };
    return toToolResult(await skydropx.post('/api/v1/shipments', payload));
  },
);

server.tool(
  'skydropx_track',
  'Consulta el estado actual y el historial de tracking de un envío. carrier_name viene de la respuesta de create_shipment (e.g. "fedex", "estafeta", "dhl").',
  {
    tracking_number: z.string().describe('Número de guía del paquetero'),
    carrier_name: z.string().describe('Nombre del paquetero en lowercase, e.g. fedex, estafeta, dhl, redpack'),
  },
  async ({ tracking_number, carrier_name }) => {
    const path = `/api/v1/shipments/tracking/${encodeURIComponent(tracking_number)}/${encodeURIComponent(carrier_name)}`;
    return toToolResult(await skydropx.get(path));
  },
);

server.tool(
  'skydropx_cancel',
  'Solicita cancelación de un envío. Solo funciona si la guía aún no fue colectada por el paquetero. La cancelación puede tomar minutos en confirmarse — vuelve a llamar para verificar el estado.',
  {
    shipment_id: z.string().describe('id del shipment (de la respuesta de skydropx_create_shipment)'),
    reason: z.string().optional().describe('Motivo opcional de cancelación'),
  },
  async ({ shipment_id, reason }) => {
    const payload: Record<string, unknown> = {};
    if (reason) payload.reason = reason;
    return toToolResult(await skydropx.post(`/api/v1/shipments/${encodeURIComponent(shipment_id)}/cancellations`, payload));
  },
);

// ─── start stdio transport ───
const transport = new StdioServerTransport();
await server.connect(transport);
