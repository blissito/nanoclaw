#!/usr/bin/env node
// Capa 1: clasifica una MUESTRA de conversaciones WABA con gpt-4o-mini.
// Dos modos:
//   DB     : node classify-topics.mjs [dbPath] [days] [N]   (corre en el droplet, usa sqlite3 CLI)
//   Muestra: node classify-topics.mjs --sample muestra.json  (corre donde sea; JSON = [{jid,text}])
// El modo muestra permite clasificar local con tu propia OPENAI_API_KEY sin mandarla al droplet.
// Salida: un objeto JSON { sample_size, resueltos, topics } a stdout.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';
const CHANNEL = 'formmy-whatsapp'; // WABA del cliente. 'whatsapp' para droplets Baileys.

// Taxonomía por defecto (SIIQTEC/totequim). Edita esta lista para otro cliente.
const TAXONOMY = [
  'Cotización',
  'Disponibilidad/Producto',
  'Envíos',
  'Soporte/Postventa',
  'Otro',
];

if (!KEY) {
  console.error('Falta OPENAI_API_KEY en el entorno.');
  process.exit(1);
}

const SAMPLE_FILE = process.argv.find((a) => a.endsWith('.json'));

function sqlJson(query) {
  const out = execFileSync('sqlite3', ['-json', process.argv[2] || '/home/nanoclaw/app/store/messages.db', query], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

// --- Construir la muestra: [{ jid, text }] ---
let samples;
if (SAMPLE_FILE) {
  samples = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8')).map((r) => ({
    jid: r.jid,
    text: String(r.text || '').slice(0, 1500),
  }));
} else {
  const DAYS = parseInt(process.argv[3] || '30', 10);
  const N = parseInt(process.argv[4] || '30', 10);
  const esc = (s) => String(s).replace(/'/g, "''");
  const chats = sqlJson(`
    SELECT m.chat_jid AS jid, COUNT(*) AS n
    FROM messages m JOIN chats c ON c.jid = m.chat_jid
    WHERE c.channel = '${CHANNEL}' AND c.is_group = 0
      AND c.jid NOT LIKE 'formmy_audit%' AND c.jid NOT LIKE '%HEALTHCHECK%'
      AND m.is_from_me = 0
      AND m.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${DAYS} days')
    GROUP BY m.chat_jid ORDER BY n DESC LIMIT ${N};`);
  samples = chats.map(({ jid }) => {
    const rows = sqlJson(`
      SELECT content FROM messages
      WHERE chat_jid = '${esc(jid)}' AND is_from_me = 0
        AND content IS NOT NULL AND content != ''
        AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${DAYS} days')
      ORDER BY timestamp LIMIT 50;`);
    return { jid, text: rows.map((r) => r.content).join('\n').slice(0, 1500) };
  });
}

const SYSTEM = `Eres un clasificador de conversaciones de atención a clientes de una empresa de productos de limpieza y jarcería.
Te paso los mensajes ESCRITOS POR EL CLIENTE en una conversación. Clasifícala en EXACTAMENTE una categoría de esta lista:
${TAXONOMY.join(', ')}.
Responde SOLO un objeto JSON: {"tema": "<categoría exacta de la lista>", "resuelto": true|false}.
"resuelto" = true si el cliente aparenta haber obtenido lo que buscaba.`;

async function classify(text) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 40,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text.slice(0, 1500) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  const tema = TAXONOMY.includes(parsed.tema) ? parsed.tema : 'Otro';
  return { tema, resuelto: !!parsed.resuelto };
}

const topics = Object.fromEntries(TAXONOMY.map((t) => [t, 0]));
let resueltos = 0;
let classified = 0;

for (const { jid, text } of samples) {
  if (!text || !text.trim()) continue;
  try {
    const { tema, resuelto } = await classify(text);
    topics[tema]++;
    classified++;
    if (resuelto) resueltos++;
  } catch (e) {
    topics['Otro']++;
    classified++;
    process.stderr.write(`warn: ${jid} -> ${e.message}\n`);
  }
}

console.log(JSON.stringify({ sample_size: classified, resueltos, topics }, null, 2));
