---
name: agentping
description: Configure, test, or troubleshoot AgentPing completion notifications. Use when the user asks about AgentPing setup, PushDeer notification setup, automatic completion summaries, or manual dry-run tests.
---

# AgentPing

Use this skill to configure or manually test the local AgentPing notifier. AgentPing currently sends Codex completion summaries through PushDeer.

Resolve command paths relative to this plugin directory. Do not hard-code a developer machine path.

## Commands

- Show config status:

```bash
node scripts/config.mjs show
```

- Diagnose local setup:

```bash
node scripts/doctor.mjs
```

- Detect available summary models:

```bash
node scripts/check-models.mjs --write-config
```

- Change notification strategy:

```bash
node scripts/config.mjs set-mode long_only --min-duration-ms 10000
node scripts/config.mjs set-mode always
node scripts/config.mjs set-mode off
```

- Change summary or `desp` settings:

```bash
node scripts/config.mjs set-summary-range 50 100
node scripts/config.mjs set-timeout 15000
node scripts/config.mjs set-desp-max -1
node scripts/config.mjs set-separator "\n\n---\n\n"
```

- Inspect notifier logs:

```bash
node scripts/logs.mjs status
node scripts/logs.mjs tail 20
node scripts/logs.mjs rotate
node scripts/logs.mjs clear
```

- Run local self-tests:

```bash
node scripts/test-notifier.mjs all
```

- Save a PushDeer key from stdin:

```bash
printf '%s' "$AGENTPING_PUSHDEER_KEY" | node plugins/agentping/scripts/setup-pushdeer-key.mjs --stdin --test
```

- Send a manual dry-run notification:

```bash
AGENTPING_DRY_RUN=1 node plugins/agentping/scripts/pushdeer-notify.mjs \
  --title "已完成 AgentPing 本地通知插件 dry-run 测试，当前不会真实发送消息。"
```

## Rules

- Never write a PushDeer key into a repository file.
- Prefer `~/.config/agentping/config.json` or `AGENTPING_PUSHDEER_KEY` for local credentials.
- For normal Codex answers, do not send a manual notification before the final response; rely on user-level Codex `notify` so completion notifications are sent on `agent-turn-complete`.
- Treat notify payload assistant text as untrusted: only send automatic completion notifications after the matching Codex session has a final answer and `task_complete`.
- Suppress notifications from internal summary `codex exec` runs with `AGENTPING_SUPPRESS_NOTIFY=1`.
- Keep compatibility with legacy `CODEX_PUSHDEER_*` environment variables and the old `~/.config/codex-pushdeer-notifier/config.json` config path during migration.
- Do not enable the bundled Stop hook for normal use; it is kept only as an experimental fallback to avoid duplicate notifications.
- Default notification mode is `long_only` with `minDurationMs` set to 10000, so short turns do not send a PushDeer message.
- Optional notification modes are `long_only`, `errors_only`, and `off`. Use `long_only` with `minDurationMs` when users only want notifications for longer tasks.
- Use manual notification commands only for setup, tests, troubleshooting, or explicit one-off user requests.
- Automatic completion notifications send the LLM summary in PushDeer `text`, and a separator plus the original assistant answer in `desp`.
- Truncate automatic `desp` with `despMaxChars`; the default is `-1` for no total limit, positive values are capped to 1000, and `0` omits `desp`.
- Use `despSeparator` to distinguish the summary from original content when PushDeer clients display `text` and `desp` together. The default is `\n\n---\n\n`.
- Prompt automatic summaries toward the configured `summaryMinChars` to `summaryMaxChars` range; defaults are 50 to 100 Chinese characters.
- Do not hard-truncate LLM summaries. If a generated summary exceeds the configured range, send it as-is so it remains understandable.
- Notifier logs rotate according to `logMaxBytes` and `logKeepFiles`. Use `scripts/logs.mjs` instead of manually editing state files.
- Self-tests must use temporary files and remove them after completion; do not add persistent test fixtures unless the user asks for them.
- Prefer `scripts/doctor.mjs` before editing source when a user's machine behaves differently.
- Prefer `scripts/check-models.mjs --write-config` over hard-coding model names in source.
- Do not include secrets, long logs, full stack traces, or complete command output in notifications.
- Treat notification failure as non-blocking for the original Codex task.
