---
name: pushdeer-notify
description: Configure, test, or troubleshoot Codex PushDeer completion notifications. Use when the user asks about PushDeer notification setup, automatic completion summaries, or manual dry-run tests.
---

# PushDeer Notify

Use this skill to configure or manually test the local PushDeer notifier bundled with the `codex-pushdeer-notifier` plugin.

Resolve command paths relative to this plugin directory. Do not hard-code a developer machine path.

## Commands

- Show config status:

```bash
node plugins/codex-pushdeer-notifier/scripts/setup-pushdeer-key.mjs --show
```

- Save a PushDeer key from stdin:

```bash
printf '%s' "$PUSHDEER_KEY" | node plugins/codex-pushdeer-notifier/scripts/setup-pushdeer-key.mjs --stdin --test
```

- Send a manual dry-run notification:

```bash
CODEX_PUSHDEER_DRY_RUN=1 node plugins/codex-pushdeer-notifier/scripts/pushdeer-notify.mjs \
  --title "已完成 PushDeer 本地通知插件 dry-run 测试，当前不会真实发送消息。"
```

## Rules

- Never write a PushDeer key into a repository file.
- Prefer `~/.config/codex-pushdeer-notifier/config.json` or `PUSHDEER_KEY` for local credentials.
- For normal Codex answers, do not send a manual notification before the final response; rely on user-level Codex `notify` so completion notifications are sent on `agent-turn-complete`.
- Do not enable the bundled Stop hook for normal use; it is kept only as an experimental fallback to avoid duplicate notifications.
- Use manual notification commands only for setup, tests, troubleshooting, or explicit one-off user requests.
- Automatic completion notifications send only PushDeer `text`; do not pass `desp` for normal completion notifications.
- Keep automatic summaries at or below 60 Chinese characters.
- Do not include secrets, long logs, full stack traces, or complete command output in notifications.
- Treat notification failure as non-blocking for the original Codex task.
