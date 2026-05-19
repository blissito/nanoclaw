/**
 * In-process metrics for the formmy-whatsapp bridge.
 *
 * Goal: give Formmy operators visibility into what the agent (Sofi/etc) is
 * actually doing per period — counts of agent invocations, unique JIDs
 * attended, outbound deliveries by type, simple latency stats.
 *
 * Volatility: reset on process restart. If you need durable counters,
 * persist into NanoClaw's existing SQLite (`store/messages.db`) — left as TODO
 * to keep this module dependency-free.
 *
 * Read via the `/metrics` HTTP endpoint mounted in formmy-whatsapp.ts.
 */
import { logger } from './logger.js';

type OutboundType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'location'
  | 'reaction'
  | 'tag'
  | string;

interface LatencyTrack {
  count: number;
  sumMs: number;
  maxMs: number;
  // Bounded sample for percentile approximation. We keep the last N samples
  // (reservoir-style FIFO trim) to avoid unbounded growth.
  samples: number[];
}

interface Counters {
  startedAt: string;
  agentInvocations: {
    total: number;
    success: number;
    error: number;
    fatal: number;
    byFolder: Record<string, number>;
    uniqueJids: Set<string>; // serialized to size in snapshot
    latency: LatencyTrack;
  };
  outbound: {
    total: number;
    byType: Record<OutboundType, number>;
    byFolder: Record<string, number>;
    uniqueJids: Set<string>;
    failures: number;
    latency: LatencyTrack;
  };
  inbound: {
    total: number;
    byOrigin: Record<string, number>; // user | echo | operator_dashboard | unknown
    uniqueJids: Set<string>;
  };
}

const SAMPLE_CAP = 500;

function newLatencyTrack(): LatencyTrack {
  return { count: 0, sumMs: 0, maxMs: 0, samples: [] };
}

const counters: Counters = {
  startedAt: new Date().toISOString(),
  agentInvocations: {
    total: 0,
    success: 0,
    error: 0,
    fatal: 0,
    byFolder: {},
    uniqueJids: new Set(),
    latency: newLatencyTrack(),
  },
  outbound: {
    total: 0,
    byType: {},
    byFolder: {},
    uniqueJids: new Set(),
    failures: 0,
    latency: newLatencyTrack(),
  },
  inbound: {
    total: 0,
    byOrigin: {},
    uniqueJids: new Set(),
  },
};

function trackLatency(track: LatencyTrack, ms: number): void {
  track.count += 1;
  track.sumMs += ms;
  if (ms > track.maxMs) track.maxMs = ms;
  track.samples.push(ms);
  if (track.samples.length > SAMPLE_CAP) {
    track.samples.splice(0, track.samples.length - SAMPLE_CAP);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function summarizeLatency(track: LatencyTrack) {
  const sorted = [...track.samples].sort((a, b) => a - b);
  return {
    count: track.count,
    avgMs: track.count > 0 ? Math.round(track.sumMs / track.count) : 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: track.maxMs,
  };
}

/**
 * Record an agent invocation result.
 * Call this AFTER runAgent returns (or throws). `durationMs` should be the
 * wall-clock time of the full invocation (spawn → final output).
 */
export function recordAgentInvocation(
  jid: string,
  folder: string,
  durationMs: number,
  status: 'success' | 'error' | 'fatal',
): void {
  const a = counters.agentInvocations;
  a.total += 1;
  if (status === 'success') a.success += 1;
  else if (status === 'error') a.error += 1;
  else a.fatal += 1;
  a.byFolder[folder] = (a.byFolder[folder] || 0) + 1;
  a.uniqueJids.add(jid);
  trackLatency(a.latency, durationMs);

  logger.info(
    {
      metric: 'agent_invocation',
      jid,
      folder,
      status,
      durationMs,
    },
    '[metrics] agent invocation',
  );
}

/**
 * Record an outbound message (postToFormmy success).
 * Call this only when the upstream delivery actually succeeded (no wrapped
 * error). `type` is the payload type from the postToFormmy payload.
 */
export function recordOutbound(
  jid: string,
  type: OutboundType,
  folder: string,
  durationMs: number,
): void {
  const o = counters.outbound;
  o.total += 1;
  o.byType[type] = (o.byType[type] || 0) + 1;
  o.byFolder[folder] = (o.byFolder[folder] || 0) + 1;
  o.uniqueJids.add(jid);
  trackLatency(o.latency, durationMs);

  logger.info(
    {
      metric: 'outbound',
      jid,
      type,
      folder,
      durationMs,
    },
    '[metrics] outbound delivered',
  );
}

export function recordOutboundFailure(
  jid: string,
  type: OutboundType,
  folder: string,
  errorSummary: string,
): void {
  counters.outbound.failures += 1;
  logger.warn(
    {
      metric: 'outbound_failure',
      jid,
      type,
      folder,
      err: errorSummary,
    },
    '[metrics] outbound failed',
  );
}

/**
 * Record an inbound message (Formmy → NanoClaw POST /message).
 * `origin` distinguishes the source as best we can deduce from the payload:
 *   - `echo` when `is_from_me=true` and `manual_mode=true` (operator phone)
 *   - `operator_dashboard` when sender is `operator@dashboard` (trigger-reply)
 *   - `user` for the regular customer inbound case
 */
export function recordInbound(
  jid: string,
  origin: 'user' | 'echo' | 'operator_dashboard' | 'unknown',
): void {
  const i = counters.inbound;
  i.total += 1;
  i.byOrigin[origin] = (i.byOrigin[origin] || 0) + 1;
  i.uniqueJids.add(jid);
}

/**
 * Public snapshot for the /metrics endpoint. Sets serialize to size; samples
 * collapse to summary stats.
 */
export function snapshotMetrics() {
  return {
    startedAt: counters.startedAt,
    uptimeSec: Math.round(
      (Date.now() - new Date(counters.startedAt).getTime()) / 1000,
    ),
    agentInvocations: {
      total: counters.agentInvocations.total,
      success: counters.agentInvocations.success,
      error: counters.agentInvocations.error,
      fatal: counters.agentInvocations.fatal,
      uniqueJids: counters.agentInvocations.uniqueJids.size,
      byFolder: counters.agentInvocations.byFolder,
      latency: summarizeLatency(counters.agentInvocations.latency),
    },
    outbound: {
      total: counters.outbound.total,
      failures: counters.outbound.failures,
      uniqueJids: counters.outbound.uniqueJids.size,
      byType: counters.outbound.byType,
      byFolder: counters.outbound.byFolder,
      latency: summarizeLatency(counters.outbound.latency),
    },
    inbound: {
      total: counters.inbound.total,
      uniqueJids: counters.inbound.uniqueJids.size,
      byOrigin: counters.inbound.byOrigin,
    },
  };
}

/**
 * Reset everything (mainly for tests). Production should restart the process.
 */
export function resetMetricsForTest(): void {
  counters.startedAt = new Date().toISOString();
  counters.agentInvocations = {
    total: 0,
    success: 0,
    error: 0,
    fatal: 0,
    byFolder: {},
    uniqueJids: new Set(),
    latency: newLatencyTrack(),
  };
  counters.outbound = {
    total: 0,
    byType: {},
    byFolder: {},
    uniqueJids: new Set(),
    failures: 0,
    latency: newLatencyTrack(),
  };
  counters.inbound = {
    total: 0,
    byOrigin: {},
    uniqueJids: new Set(),
  };
}
