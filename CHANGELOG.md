# Changelog

All notable changes to GhostyClaw will be documented in this file.

## Unreleased

- **fix (WABA hardening):** Public-profile (customer-facing) chats can no longer create recurring (`interval`/`cron`) scheduled tasks — they degrade to a single `once` run at task-creation time in `src/ipc.ts`. Prevents the duplicate-send loop where a self-scheduled recurring task re-sends the same artifact (e.g. a quote) every N minutes in isolated context. Admin/internal groups keep recurring tasks. (incident 2026-06-13)
- **fix:** Correct fallback model to `claude-sonnet-4-20250514` (was using nonexistent `claude-sonnet-4-6-20250514`, causing error loops on rate limit)
- **fix:** Mark model/auth API errors as fatal — no retry, no channel spam
- **fix:** Add 5-minute cooldown per group after exhausted retries to prevent repeated error cycles
- **fix:** Suppress duplicate error messages to channels (max 1 per 5 min per group)

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
