/**
 * Spotify Web API MCP Server — stdio transport.
 *
 * OAuth multi-user vía ghosty.studio (mismo patrón que el MCP de Canva):
 *   - spotify_connect → genera link, el user autoriza en Spotify
 *   - el resto de tools piden /api/spotify/permit antes (cuotas + access_token)
 *
 * Env:
 *   GHOSTY_STUDIO_URL    — default https://ghosty.studio
 *   NANOCLAW_ADMIN_TOKEN — Bearer del Deployment (mismo token que admin-api / usage-reporter)
 *   NANOCLAW_GROUP_FOLDER — agent_group_id
 *   NANOCLAW_CHAT_JID     — user_id (jid del chat)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callSpotify, getConnectLink, disconnectSpotify } from './api.js';

const server = new McpServer({ name: 'spotify', version: '1.0.0' });

server.tool(
  'spotify_connect',
  'Genera un link mágico para que el usuario conecte su cuenta de Spotify. Ejecuta esta tool PRIMERO si el usuario aún no autorizó, o si otra tool devuelve "needs_oauth". Manda el link al usuario por WhatsApp; el link expira en 10 minutos.',
  {},
  async () => getConnectLink(),
);

server.tool(
  'spotify_disconnect',
  'Desconecta la cuenta de Spotify del usuario actual: borra los tokens guardados y revoca el acceso en Spotify (best-effort). Úsala cuando el user pida explícitamente "desconecta spotify", "desvincula", "olvida mi spotify", "revoca acceso". Después de esto, la próxima tool que necesite Spotify pedirá `spotify_connect` de nuevo.',
  {},
  async () => disconnectSpotify(),
);

server.tool(
  'spotify_get_profile',
  'Obtiene el perfil del usuario conectado en Spotify (display name, id, producto/plan). Útil para confirmar qué cuenta está vinculada y si es Premium. Costo: 1.',
  {},
  async () => callSpotify('get_profile', { method: 'GET', path: '/me', cost: 1 }),
);

server.tool(
  'spotify_search',
  'Busca en el catálogo de Spotify (tracks, artistas, álbumes, playlists). Devuelve nombres + URIs (spotify:track:...) que luego puedes usar en spotify_play o spotify_add_to_queue. Costo: 1.',
  {
    query: z.string().describe('Texto de búsqueda libre, ej. "bad bunny tití me preguntó"'),
    type: z
      .enum(['track', 'artist', 'album', 'playlist'])
      .optional()
      .describe('Tipo de resultado (default: track)'),
    limit: z.number().int().min(1).max(50).optional().describe('Cantidad de resultados (default 10)'),
  },
  async ({ query, type, limit }) => {
    const qs = new URLSearchParams({ q: query, type: type || 'track', limit: String(limit ?? 10) });
    return callSpotify('search', { method: 'GET', path: `/search?${qs}`, cost: 1 });
  },
);

server.tool(
  'spotify_now_playing',
  'Devuelve lo que el usuario está escuchando ahora mismo (track, artista, progreso, dispositivo). Si no hay nada sonando, devuelve status "nothing_playing". Costo: 1.',
  {},
  async () => callSpotify('now_playing', { method: 'GET', path: '/me/player/currently-playing', cost: 1 }),
);

server.tool(
  'spotify_devices',
  'Lista los dispositivos disponibles del usuario (celular, compu, speaker) con su device_id y cuál está activo. Úsala cuando el control de reproducción falle con "no hay dispositivo activo". Costo: 1.',
  {},
  async () => callSpotify('devices', { method: 'GET', path: '/me/player/devices', cost: 1 }),
);

server.tool(
  'spotify_play',
  'Inicia o reanuda la reproducción. ⚠️ Requiere Spotify Premium y un dispositivo activo (abre Spotify en algún lado primero, o pasa device_id de spotify_devices). Pasa `uris` para tracks específicos o `context_uri` para un álbum/playlist; sin nada = reanuda lo pausado. Costo: 1.',
  {
    uris: z
      .array(z.string())
      .optional()
      .describe('Lista de URIs de tracks a reproducir, ej. ["spotify:track:..."]'),
    context_uri: z
      .string()
      .optional()
      .describe('URI de un álbum/playlist/artista, ej. "spotify:playlist:..." o "spotify:album:..."'),
    device_id: z.string().optional().describe('Dispositivo destino (de spotify_devices). Omitir = dispositivo activo.'),
  },
  async ({ uris, context_uri, device_id }) => {
    const qs = device_id ? `?${new URLSearchParams({ device_id })}` : '';
    const body: Record<string, unknown> = {};
    if (uris) body.uris = uris;
    if (context_uri) body.context_uri = context_uri;
    return callSpotify('play', {
      method: 'PUT',
      path: `/me/player/play${qs}`,
      body: Object.keys(body).length ? body : undefined,
      cost: 1,
    });
  },
);

server.tool(
  'spotify_pause',
  'Pausa la reproducción actual. Requiere Premium + dispositivo activo. Costo: 1.',
  {
    device_id: z.string().optional().describe('Dispositivo destino. Omitir = dispositivo activo.'),
  },
  async ({ device_id }) => {
    const qs = device_id ? `?${new URLSearchParams({ device_id })}` : '';
    return callSpotify('pause', { method: 'PUT', path: `/me/player/pause${qs}`, cost: 1 });
  },
);

server.tool(
  'spotify_next',
  'Salta a la siguiente canción. Requiere Premium + dispositivo activo. Costo: 1.',
  {
    device_id: z.string().optional().describe('Dispositivo destino. Omitir = dispositivo activo.'),
  },
  async ({ device_id }) => {
    const qs = device_id ? `?${new URLSearchParams({ device_id })}` : '';
    return callSpotify('next', { method: 'POST', path: `/me/player/next${qs}`, cost: 1 });
  },
);

server.tool(
  'spotify_previous',
  'Regresa a la canción anterior. Requiere Premium + dispositivo activo. Costo: 1.',
  {
    device_id: z.string().optional().describe('Dispositivo destino. Omitir = dispositivo activo.'),
  },
  async ({ device_id }) => {
    const qs = device_id ? `?${new URLSearchParams({ device_id })}` : '';
    return callSpotify('previous', { method: 'POST', path: `/me/player/previous${qs}`, cost: 1 });
  },
);

server.tool(
  'spotify_add_to_queue',
  'Agrega un track a la cola de reproducción del usuario. Requiere Premium + dispositivo activo. Pasa el URI (de spotify_search). Costo: 1.',
  {
    uri: z.string().describe('URI del track, ej. "spotify:track:..."'),
    device_id: z.string().optional().describe('Dispositivo destino. Omitir = dispositivo activo.'),
  },
  async ({ uri, device_id }) => {
    const params: Record<string, string> = { uri };
    if (device_id) params.device_id = device_id;
    return callSpotify('add_to_queue', { method: 'POST', path: `/me/player/queue?${new URLSearchParams(params)}`, cost: 1 });
  },
);

server.tool(
  'spotify_list_playlists',
  'Lista las playlists del usuario (propias y seguidas), con nombre, id y URI. Costo: 1.',
  {
    limit: z.number().int().min(1).max(50).optional().describe('Cantidad (default 20)'),
  },
  async ({ limit }) => {
    const qs = new URLSearchParams({ limit: String(limit ?? 20) });
    return callSpotify('list_playlists', { method: 'GET', path: `/me/playlists?${qs}`, cost: 1 });
  },
);

server.tool(
  'spotify_get_playlist_tracks',
  'Lista las canciones de una playlist específica (nombre, artista, URI). Costo: 1.',
  {
    playlist_id: z.string().describe('ID de la playlist (de spotify_list_playlists)'),
    limit: z.number().int().min(1).max(100).optional().describe('Cantidad (default 50)'),
  },
  async ({ playlist_id, limit }) => {
    const qs = new URLSearchParams({ limit: String(limit ?? 50) });
    return callSpotify('get_playlist_tracks', {
      method: 'GET',
      path: `/playlists/${encodeURIComponent(playlist_id)}/tracks?${qs}`,
      cost: 1,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
