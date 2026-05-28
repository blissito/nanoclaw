---
name: spotify
description: Trabaja con la cuenta de Spotify del usuario — buscar, ver qué suena, controlar reproducción (play/pause/next/queue) y listar playlists vía Spotify Web API. OAuth multi-user (cada user vincula su Spotify). Dispara cuando el user pida música, "pon una rúla", "qué estoy escuchando", "agrega esto a la cola".
---

# Spotify — música del usuario

Tienes tools MCP para hablar con Spotify en nombre del user actual. La conexión es **per-user** (vía OAuth en ghosty.studio); cada user tiene su propia cuenta vinculada. Mismo patrón que el MCP de Canva.

## Tools disponibles

| Tool | Para qué | Costo |
|------|----------|-------|
| `spotify_connect` | Genera link mágico para que el user vincule su Spotify | 0 |
| `spotify_disconnect` | Desconecta la cuenta vinculada (borra tokens + revoca acceso) | 0 |
| `spotify_get_profile` | Confirmar qué cuenta está vinculada y si es Premium | 1 |
| `spotify_search` | Buscar tracks/artistas/álbumes/playlists → devuelve URIs | 1 |
| `spotify_now_playing` | Qué está sonando ahora (track, artista, progreso) | 1 |
| `spotify_devices` | Listar dispositivos disponibles + device_id | 1 |
| `spotify_play` | Iniciar/reanudar reproducción (uris o context_uri) | 1 |
| `spotify_pause` | Pausar | 1 |
| `spotify_next` | Siguiente canción | 1 |
| `spotify_previous` | Canción anterior | 1 |
| `spotify_add_to_queue` | Agregar un track a la cola | 1 |
| `spotify_list_playlists` | Listar playlists del user | 1 |
| `spotify_get_playlist_tracks` | Canciones de una playlist | 1 |

## El flujo OAuth (lee esto antes de la primera llamada)

Si una tool devuelve `needs_oauth`:

1. Llama `spotify_connect` → obtienes un link
2. Mándale el link al user diciéndole algo como:
   > Para conectar tu Spotify, abre este link y autoriza: <link>. Expira en 10 min.
3. Espera a que el user diga "ya" / "listo" antes de reintentar
4. Una vez autorizado, todas las tools funcionan sin pasos adicionales

**Nunca pretendas que el user ya conectó su Spotify.** Si la tool dice `needs_oauth`, sigue el flujo arriba.

### Desconexión

Si el user pide explícitamente "desconecta spotify", "desvincula", "olvida mi spotify", "revoca acceso", llama `spotify_disconnect`. Respuestas posibles:

- `revoked: true, remote_revoke: 'ok'` → "Listo, desvinculé tu Spotify."
- `revoked: true, remote_revoke: 'failed'` → "Borré la conexión local pero no logré revocarla en Spotify. Si quieres revocar manualmente: spotify.com → Cuenta → Apps."
- `revoked: false` → "No tenías ninguna cuenta vinculada en este chat."

## ⚠️ Premium + dispositivo activo (lee antes de prometer "te la pongo")

El **control de reproducción** (`spotify_play`, `spotify_pause`, `spotify_next`, `spotify_previous`, `spotify_add_to_queue`) **solo funciona si el user tiene Spotify Premium Y hay un dispositivo activo** (la app de Spotify abierta en algún celular/compu/speaker).

- Búsqueda, perfil, now_playing, playlists → funcionan con cualquier cuenta (free o premium).
- Reproducción → Premium obligatorio. Si una tool devuelve **403**, el user no es Premium: **no reintentes**, explícale en lenguaje natural que el control remoto requiere Premium y ofrécele mandarle el link de la canción para que la abra él.
- Si devuelve **404 / no hay dispositivo activo**: pídele al user que abra Spotify en algún dispositivo, o usa `spotify_devices` para ver cuáles hay y pasa el `device_id` a la tool de reproducción.

## Cuotas — sé eficiente

Cada llamada se registra y cuenta contra cuota. Si una tool devuelve cuota agotada, avísale al user con el `retry_after_seconds` que viene en el error. No hagas polling agresivo de `now_playing`.

## Workflows comunes

### "¿Qué estoy escuchando?"
```
spotify_now_playing()
```
Si devuelve `status: "nothing_playing"`, dile que no hay nada sonando ahorita.

### "Pon <canción/artista>"
1. `spotify_search({ query: 'tití me preguntó bad bunny', type: 'track' })` → toma el `uri` del primer resultado
2. `spotify_play({ uris: ['spotify:track:...'] })`
3. Si 404 (sin dispositivo) → `spotify_devices()`, pide al user que abra Spotify, reintenta con `device_id`
4. Si 403 → el user no es Premium; manda el link de la canción en vez de reproducir

### "Agrega esto a la cola"
1. `spotify_search` para conseguir el URI
2. `spotify_add_to_queue({ uri: 'spotify:track:...' })`

### "Pon mi playlist X"
1. `spotify_list_playlists()` → encuentra la playlist por nombre, toma su URI (`spotify:playlist:...`)
2. `spotify_play({ context_uri: 'spotify:playlist:...' })`

### "Pausa / siguiente / anterior"
```
spotify_pause()   |   spotify_next()   |   spotify_previous()
```
Mismas reglas de Premium + dispositivo activo.

## Errores típicos

- **`needs_oauth`** → flujo OAuth (ver arriba)
- **Cuota agotada** → reportar `retry_after_seconds` al user
- **`Spotify 401`** → el access_token expiró y el refresh falló. Llama a `spotify_connect` para re-vincular.
- **`Spotify 403`** → el user no es Premium (o falta scope). No reintentes reproducción; ofrece el link de la canción.
- **`Spotify 404` / NO_ACTIVE_DEVICE** → no hay dispositivo activo. Pide abrir Spotify o usa `spotify_devices` + `device_id`.

## Lo que NO puedes hacer

- Reproducir audio dentro del chat — solo controlas el Spotify del user en SUS dispositivos
- Controlar reproducción sin Premium (limitación de Spotify, no nuestra)
- Acceder a la cuenta de OTRO user (cada token está scoped al user que autorizó)
