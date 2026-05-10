/**
 * Rate limiting for public-profile groups (Formmy WABA end-users).
 *
 * Sliding-window counters per JID kept in-memory. State resets on service
 * restart, which is acceptable for a soft cap — the daily window is for
 * cost containment, not regulatory accounting.
 *
 * Three caps applied in order: daily token cost > daily spawn count > burst.
 * A blocked check does NOT increment counters, so an abusive sender can't
 * extend their own block by hammering.
 */
export const BURST_WINDOW_MS = 5 * 60 * 1000;
export const BURST_MAX_SPAWNS = 12;
export const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DAILY_MAX_SPAWNS = 80;
export const DAILY_MAX_INPUT_TOKENS = 150_000;
export const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

const spawnLog = new Map<string, number[]>();
const tokenLog = new Map<string, Array<{ ts: number; tokens: number }>>();
const lastNotifiedAt = new Map<string, number>();

export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'burst' | 'daily-spawns' | 'daily-tokens';
      retryAfterMs: number;
      shouldNotify: boolean;
    };

function pruneSpawns(arr: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return arr.filter((t) => t >= cutoff);
}

function pruneTokens(
  arr: Array<{ ts: number; tokens: number }>,
  now: number,
): Array<{ ts: number; tokens: number }> {
  const cutoff = now - DAILY_WINDOW_MS;
  return arr.filter((e) => e.ts >= cutoff);
}

function maybeNotify(jid: string, now: number): boolean {
  const last = lastNotifiedAt.get(jid) ?? 0;
  if (now - last < NOTIFY_COOLDOWN_MS) return false;
  lastNotifiedAt.set(jid, now);
  return true;
}

export function checkPublicRateLimit(
  jid: string,
  now: number = Date.now(),
): RateLimitDecision {
  const allSpawns = pruneSpawns(spawnLog.get(jid) ?? [], now, DAILY_WINDOW_MS);
  spawnLog.set(jid, allSpawns);

  const dailyTokens = pruneTokens(tokenLog.get(jid) ?? [], now);
  tokenLog.set(jid, dailyTokens);
  const tokenTotal = dailyTokens.reduce((s, e) => s + e.tokens, 0);

  if (tokenTotal >= DAILY_MAX_INPUT_TOKENS) {
    const oldest = dailyTokens[0]?.ts ?? now;
    return {
      allowed: false,
      reason: 'daily-tokens',
      retryAfterMs: Math.max(0, DAILY_WINDOW_MS - (now - oldest)),
      shouldNotify: maybeNotify(jid, now),
    };
  }

  if (allSpawns.length >= DAILY_MAX_SPAWNS) {
    const oldest = allSpawns[0];
    return {
      allowed: false,
      reason: 'daily-spawns',
      retryAfterMs: Math.max(0, DAILY_WINDOW_MS - (now - oldest)),
      shouldNotify: maybeNotify(jid, now),
    };
  }

  const burstSpawns = allSpawns.filter((t) => now - t < BURST_WINDOW_MS);
  if (burstSpawns.length >= BURST_MAX_SPAWNS) {
    const oldest = burstSpawns[0];
    return {
      allowed: false,
      reason: 'burst',
      retryAfterMs: Math.max(0, BURST_WINDOW_MS - (now - oldest)),
      shouldNotify: maybeNotify(jid, now),
    };
  }

  allSpawns.push(now);
  spawnLog.set(jid, allSpawns);
  return { allowed: true };
}

export function recordPublicInputTokens(
  jid: string,
  tokens: number,
  now: number = Date.now(),
): void {
  if (tokens <= 0) return;
  const arr = pruneTokens(tokenLog.get(jid) ?? [], now);
  arr.push({ ts: now, tokens });
  tokenLog.set(jid, arr);
}

export function formatRetryMessage(decision: RateLimitDecision): string {
  if (decision.allowed) return '';
  const min = Math.ceil(decision.retryAfterMs / 60_000);
  const human =
    min < 60
      ? `${min} min`
      : min < 60 * 24
        ? `${Math.ceil(min / 60)} h`
        : `${Math.ceil(min / (60 * 24))} día(s)`;
  if (decision.reason === 'burst') {
    return `Vas muy rápido. Pausa unos minutos e intenta de nuevo en ~${human}.`;
  }
  return `Llegaste al límite diario de mensajes. Vuelve a escribirme en ~${human}.`;
}

export function _resetPublicRateLimitState(): void {
  spawnLog.clear();
  tokenLog.clear();
  lastNotifiedAt.clear();
}
