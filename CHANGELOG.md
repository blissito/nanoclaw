# Changelog

All notable changes to GhostyClaw will be documented in this file.

## Unreleased

- **fix:** Correct fallback model to `claude-sonnet-4-5-20241022` (was using nonexistent `claude-sonnet-4-6-20250514`, causing error loops on rate limit)
- **fix:** Mark model/auth API errors as fatal — no retry, no channel spam
- **fix:** Add 5-minute cooldown per group after exhausted retries to prevent repeated error cycles
- **fix:** Suppress duplicate error messages to channels (max 1 per 5 min per group)

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
