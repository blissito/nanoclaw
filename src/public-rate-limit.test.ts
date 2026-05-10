import { describe, it, expect, beforeEach } from 'vitest';

import {
  BURST_MAX_SPAWNS,
  BURST_WINDOW_MS,
  DAILY_MAX_INPUT_TOKENS,
  DAILY_MAX_SPAWNS,
  DAILY_WINDOW_MS,
  NOTIFY_COOLDOWN_MS,
  _resetPublicRateLimitState,
  checkPublicRateLimit,
  formatRetryMessage,
  recordPublicInputTokens,
} from './public-rate-limit.js';

describe('public-rate-limit', () => {
  beforeEach(() => {
    _resetPublicRateLimitState();
  });

  describe('burst window', () => {
    it('allows up to BURST_MAX_SPAWNS spawns inside the window', () => {
      const t0 = 1_000_000_000;
      for (let i = 0; i < BURST_MAX_SPAWNS; i++) {
        const d = checkPublicRateLimit('jid-a', t0 + i * 1000);
        expect(d.allowed).toBe(true);
      }
    });

    it('blocks the spawn that exceeds the burst cap', () => {
      const t0 = 1_000_000_000;
      for (let i = 0; i < BURST_MAX_SPAWNS; i++) {
        checkPublicRateLimit('jid-a', t0 + i * 1000);
      }
      const d = checkPublicRateLimit('jid-a', t0 + BURST_MAX_SPAWNS * 1000);
      expect(d.allowed).toBe(false);
      if (!d.allowed) {
        expect(d.reason).toBe('burst');
        expect(d.retryAfterMs).toBeGreaterThan(0);
        expect(d.retryAfterMs).toBeLessThanOrEqual(BURST_WINDOW_MS);
      }
    });

    it('does not consume a slot on a blocked check', () => {
      const t0 = 1_000_000_000;
      for (let i = 0; i < BURST_MAX_SPAWNS; i++) {
        checkPublicRateLimit('jid-a', t0 + i * 1000);
      }
      // Three blocked attempts back-to-back
      checkPublicRateLimit('jid-a', t0 + BURST_MAX_SPAWNS * 1000);
      checkPublicRateLimit('jid-a', t0 + BURST_MAX_SPAWNS * 1000 + 100);
      checkPublicRateLimit('jid-a', t0 + BURST_MAX_SPAWNS * 1000 + 200);
      // Once the window slides past the first spawn, exactly one slot opens
      const slid = checkPublicRateLimit('jid-a', t0 + BURST_WINDOW_MS + 1);
      expect(slid.allowed).toBe(true);
    });

    it('clears the burst block after the window passes', () => {
      const t0 = 1_000_000_000;
      for (let i = 0; i < BURST_MAX_SPAWNS + 1; i++) {
        checkPublicRateLimit('jid-a', t0 + i * 1000);
      }
      const after = checkPublicRateLimit(
        'jid-a',
        t0 + BURST_WINDOW_MS + 10_000,
      );
      expect(after.allowed).toBe(true);
    });

    it('tracks JIDs independently', () => {
      const t0 = 1_000_000_000;
      for (let i = 0; i < BURST_MAX_SPAWNS; i++) {
        checkPublicRateLimit('jid-a', t0 + i * 1000);
      }
      expect(checkPublicRateLimit('jid-a', t0).allowed).toBe(false);
      expect(checkPublicRateLimit('jid-b', t0).allowed).toBe(true);
    });
  });

  describe('daily spawn cap', () => {
    it('blocks once DAILY_MAX_SPAWNS is reached, even when spaced out past burst', () => {
      const t0 = 1_000_000_000;
      const spacing = (BURST_WINDOW_MS + 1000) / (BURST_MAX_SPAWNS - 1);
      for (let i = 0; i < DAILY_MAX_SPAWNS; i++) {
        const d = checkPublicRateLimit('jid-a', t0 + i * spacing);
        expect(d.allowed).toBe(true);
      }
      const d = checkPublicRateLimit('jid-a', t0 + DAILY_MAX_SPAWNS * spacing);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe('daily-spawns');
    });
  });

  describe('daily token cap', () => {
    it('blocks once recorded input tokens cross the daily threshold', () => {
      const t0 = 1_000_000_000;
      // Stay under spawn caps so we isolate the token check
      checkPublicRateLimit('jid-a', t0);
      recordPublicInputTokens('jid-a', DAILY_MAX_INPUT_TOKENS, t0 + 100);
      const d = checkPublicRateLimit('jid-a', t0 + 1000);
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe('daily-tokens');
    });

    it('forgets token usage older than DAILY_WINDOW_MS', () => {
      const t0 = 1_000_000_000;
      recordPublicInputTokens('jid-a', DAILY_MAX_INPUT_TOKENS * 2, t0);
      const after = checkPublicRateLimit('jid-a', t0 + DAILY_WINDOW_MS + 1000);
      expect(after.allowed).toBe(true);
    });
  });

  describe('notification throttle', () => {
    it('notifies only once per cooldown for repeated blocked attempts', () => {
      const t0 = 1_000_000_000;
      for (let i = 0; i < BURST_MAX_SPAWNS; i++) {
        checkPublicRateLimit('jid-a', t0 + i * 1000);
      }
      const first = checkPublicRateLimit('jid-a', t0 + BURST_MAX_SPAWNS * 1000);
      const second = checkPublicRateLimit(
        'jid-a',
        t0 + BURST_MAX_SPAWNS * 1000 + 100,
      );
      expect(first.allowed).toBe(false);
      expect(second.allowed).toBe(false);
      if (!first.allowed) expect(first.shouldNotify).toBe(true);
      if (!second.allowed) expect(second.shouldNotify).toBe(false);

      const later = checkPublicRateLimit(
        'jid-a',
        t0 + BURST_MAX_SPAWNS * 1000 + NOTIFY_COOLDOWN_MS + 1,
      );
      if (!later.allowed) expect(later.shouldNotify).toBe(true);
    });
  });

  describe('formatRetryMessage', () => {
    it('renders burst messages with a minutes hint', () => {
      const msg = formatRetryMessage({
        allowed: false,
        reason: 'burst',
        retryAfterMs: 3 * 60_000,
        shouldNotify: true,
      });
      expect(msg).toMatch(/rápido/);
      expect(msg).toMatch(/3 min/);
    });

    it('renders daily messages in hours when appropriate', () => {
      const msg = formatRetryMessage({
        allowed: false,
        reason: 'daily-spawns',
        retryAfterMs: 4 * 60 * 60_000,
        shouldNotify: true,
      });
      expect(msg).toMatch(/límite diario/);
      expect(msg).toMatch(/4 h/);
    });
  });
});
