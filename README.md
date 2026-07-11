# AgentPing

AgentPing sends concise completion summaries when your AI agents finish.

It supports Codex and Claude Code completion events with PushDeer delivery. The PushDeer `text` field is a short LLM-generated summary of the full assistant answer. The `desp` field contains the configured answer preview. If the summary model fails or times out, AgentPing falls back to a complete short sentence or a generic completion notice for `text`.

AgentPing uses Codex `notify` with the `agent-turn-complete` event and Claude Code's official `Stop` and `StopFailure` hooks. Claude events are handed to a detached worker so notifications remain asynchronous from the user's perspective. Both platform adapters share the same config, templates, notification modes, preview formatter, logging, and PushDeer sender.

## What It Does

- Runs after a Codex or Claude Code answer is complete.
- Ignores intermediate commentary/status messages and waits for Codex session `task_complete`.
- Summarizes the full user question and assistant answer with the current platform's CLI: `codex exec` for Codex and a safe, non-persistent Claude print process for Claude Code.
- Sends the summary in PushDeer `text`.
- Sends a separator plus the original assistant answer in PushDeer `desp`, truncated to `despMaxChars`.
- Asks the summary model for 50 to 100 Chinese characters by default.
- Does not hard-truncate LLM summaries; semantic completeness is preferred if the model slightly exceeds the configured range.
- Keeps approximately the first 200 and last 150 characters of the answer at punctuation boundaries, without a total `desp` limit by default.
- Supports notification modes: always, long tasks only, errors only, or off.
- Supports notification templates for PushDeer `text` and `desp`.
- Supports project-level `.agentping.json` config, without project-stored PushDeer keys.
- Rotates local notifier logs so troubleshooting data does not grow without bound.
- Keeps local logs privacy-safe by default; full text/stderr previews require `debugLogs`.
- Records summary source, elapsed time, and fallback error reason in notifier logs.
- Includes local self-test commands that use temporary files and dry-run PushDeer sends.
- Stores separate Codex and Claude PushDeer keys outside the repository so the receiving client can distinguish both sources.
- Keeps compatibility with the old `codex-pushdeer` CLI and `CODEX_PUSHDEER_*` environment variables during migration.
- Treats notification failures as non-blocking for the original agent task.

## Requirements

- macOS or Linux with Node.js available as `node`.
- Codex CLI available as `codex`, Claude Code available as `claude`, or both.
- A separate PushDeer key for every installed agent you want to notify from.
- Access to a summary model through the corresponding agent CLI.

The installer detects available Codex models with `codex debug models` and stores the selected summary model in local config. If you want to force a model, pass it during install:

```bash
node scripts/install.mjs --summary-model gpt-5.4-mini
```

## Install

Clone this repository, then run the installer:

```bash
git clone https://github.com/planetInGalaxy/agentping.git
cd agentping
node scripts/install.mjs
```

The installer will:

- Configure every supported agent found on the machine.
- For Codex, install `agentping@agentping`, configure `~/.codex/config.toml`, and detect a summary model.
- For Claude Code, merge lightweight `Stop` and `StopFailure` hooks into `~/.claude/settings.json` without replacing unrelated hooks. The hook launches the notification worker in a detached process so interactive sessions and one-shot `claude -p` commands behave consistently.
- Prompt separately for missing Codex and Claude PushDeer keys.
- Store both keys only in `~/.config/agentping/config.json` with mode `0600`.

To pass the key non-interactively:

```bash
AGENTPING_PUSHDEER_KEY='PDU...' \
AGENTPING_CLAUDE_PUSHDEER_KEY='PDU...' \
node scripts/install.mjs
```

To send a real PushDeer test notification during setup:

```bash
AGENTPING_PUSHDEER_KEY='PDU...' \
AGENTPING_CLAUDE_PUSHDEER_KEY='PDU...' \
node scripts/install.mjs --test
```

To preview what the installer would do without changing local files:

```bash
node scripts/install.mjs --dry-run --skip-key
```

Useful install flags:

```bash
node scripts/install.mjs --summary-model gpt-5.4-mini
node scripts/install.mjs --claude-summary-model haiku
node scripts/install.mjs --summary-min-chars 50 --summary-max-chars 100
node scripts/install.mjs --llm-timeout-ms 15000
node scripts/install.mjs --desp-max-chars -1
node scripts/install.mjs --desp-separator "\n\n---\n\n"
node scripts/install.mjs --final-wait-ms 8000
node scripts/install.mjs --notify-mode always
node scripts/install.mjs --notify-mode long_only --min-duration-ms 30000
node scripts/install.mjs --log-max-bytes 2097152 --log-keep-files 3
node scripts/install.mjs --debug-logs off
node scripts/install.mjs --title-template "{summary}"
node scripts/install.mjs --desp-template "用时：{durationZh}{separator}{finalTextPreview}"
node scripts/install.mjs --no-desp
node scripts/install.mjs --no-desp-separator
node scripts/install.mjs --skip-model-check
node scripts/install.mjs --skip-codex
node scripts/install.mjs --skip-claude
node scripts/install.mjs --force-notify
node scripts/install.mjs --install-legacy-shim
node scripts/install.mjs --skip-legacy-shim
```

Codex uses the configured notify command for subsequent turns. Claude Code watches its settings file and normally picks up the hooks without a restart; `/hooks` shows their installed source and details.

## Package-Style Usage

This repository is npm-package ready and exposes an `agentping` command. After publishing to npm, users should install it globally so Codex `notify` points at a stable script path:

```bash
npm install -g agentping
agentping install
```

Until it is published to npm, use the clone-based install above.

The old `codex-pushdeer` command remains as a compatibility alias, but new docs and installs should use `agentping`.

## Existing Notify Config

Codex supports a user-level `notify` command in `~/.codex/config.toml`. If the installer detects an existing top-level `notify`, it will ask before replacing it.

Codex Desktop integrations can wrap an existing notifier with `--previous-notify`, for example when Computer Use owns the top-level `notify` command. In that case, the installer preserves the wrapper and updates the wrapped previous notifier to AgentPing when it points at the old Codex PushDeer notifier or the legacy local multiplexer. `agentping doctor` treats this wrapper chain as a valid AgentPing setup.

If `~/.codex/notify-multiplexer.mjs` already exists and looks like an AgentPing/Codex PushDeer shim, the installer refreshes it to call the current AgentPing checkout. This improves old-session coverage because older Codex tasks that still call the legacy multiplexer path can route to the new notifier without a full restart. If a session cached a completely different command at startup, Codex still needs a new task or restart.

For non-interactive installs that should replace the existing notifier:

```bash
node scripts/install.mjs --force-notify
```

If you already use another notifier, do not force overwrite unless replacing it is intended.

## Configuration Files

Both platform-specific PushDeer keys are saved here:

```text
~/.config/agentping/config.json
```

The Codex notify command is written here:

```text
~/.codex/config.toml
```

The installer writes a line like this:

```toml
notify = ["node", "/absolute/path/to/repo/plugins/agentping/scripts/pushdeer-notify-event.mjs"]
```

Claude Code hooks are merged into:

```text
~/.claude/settings.json
```

The Claude hooks invoke `claude-notify-launcher.mjs`, which immediately hands the event to a detached `claude-notify-event.mjs` worker. LLM summary generation does not delay the final answer UI and continues after a one-shot Claude process exits.

The notifier config stores local runtime settings:

```json
{
  "CodexPushKey": "PDU...",
  "ClaudePushKey": "PDU...",
  "endpoint": "https://api2.pushdeer.com/message/push",
  "CodexSummaryModel": "gpt-5.4-mini",
  "ClaudeSummaryModel": "haiku",
  "summaryMinChars": 50,
  "summaryMaxChars": 100,
  "summaryFallbackText": "摘要未生成，请看原回答",
  "llmTimeoutMs": 16000,
  "despMaxChars": -1,
  "despSeparator": "\n\n---\n\n",
  "finalWaitMs": 8000,
  "notifyMode": "long_only",
  "minDurationMs": 10000,
  "logMaxBytes": 2097152,
  "logKeepFiles": 3,
  "debugLogs": false,
  "titleTemplate": "{summary}",
  "despTemplate": "用时：{durationZh}{separator}{finalTextPreview}",
  "finalTextPreviewHeadChars": 200,
  "finalTextPreviewTailChars": 150,
  "finalTextPreviewMarker": "\n......\n",
  "_说明": [
    "CodexPushKey：Codex 专用 PushDeer 推送密钥；项目配置中的密钥会被忽略。",
    "ClaudePushKey：Claude Code 专用 PushDeer 推送密钥；项目配置中的密钥会被忽略。",
    "其他配置项的中文说明由 AgentPing 自动写入此数组。"
  ]
}
```

The user-level file `~/.config/agentping/config.json` is the global base configuration and applies to every project. AgentPing writes every supported global setting to this file and keeps Chinese documentation in one `_说明` array at the end, separated from active settings. The array is documentation only and does not affect runtime behavior.

Older `pushkey`, `claudePushkey`, `summaryModel`, and `claudeSummaryModel` fields remain readable for backward compatibility. The next AgentPing config write migrates them to `CodexPushKey`, `ClaudePushKey`, `CodexSummaryModel`, and `ClaudeSummaryModel` automatically.

Project-level settings can be stored in `.agentping.json` or `agentping.config.json` in a project directory. AgentPing starts at the current working directory, searches upward for the nearest project config, and overlays its values on top of the global config. Only settings that differ for that project need to be included. Project config intentionally ignores every Codex and Claude key field, so secrets stay in `~/.config/agentping/config.json`.

Create a documented project config in the current project with `agentping config init-project`. Use `agentping config show` from that project to inspect the effective merged configuration and the project config path that was found.

## Runtime Settings

Optional environment variables:

```bash
export AGENTPING_SUMMARY_MODEL=gpt-5.4-mini
export AGENTPING_CLAUDE_SUMMARY_MODEL=haiku
export AGENTPING_SUMMARY_MIN_CHARS=50
export AGENTPING_SUMMARY_MAX_CHARS=100
export AGENTPING_SUMMARY_FALLBACK_TEXT='摘要未生成，请看原回答'
export AGENTPING_LLM_TIMEOUT_MS=16000
export AGENTPING_DESP_MAX_CHARS=-1
export AGENTPING_DESP_SEPARATOR='\n\n---\n\n'
export AGENTPING_FINAL_WAIT_MS=8000
export AGENTPING_NOTIFY_MODE=long_only
export AGENTPING_MIN_DURATION_MS=10000
export AGENTPING_LOG_MAX_BYTES=2097152
export AGENTPING_LOG_KEEP_FILES=3
export AGENTPING_DEBUG_LOGS=0
export AGENTPING_TITLE_TEMPLATE='{summary}'
export AGENTPING_DESP_TEMPLATE='用时：{durationZh}{separator}{finalTextPreview}'
export AGENTPING_FINAL_TEXT_PREVIEW_HEAD_CHARS=200
export AGENTPING_FINAL_TEXT_PREVIEW_TAIL_CHARS=150
export AGENTPING_FINAL_TEXT_PREVIEW_MARKER='\n......\n'
export AGENTPING_PUSHDEER_ENDPOINT=https://api2.pushdeer.com/message/push
export AGENTPING_PUSHDEER_KEY='PDU...'
export AGENTPING_CLAUDE_PUSHDEER_KEY='PDU...'
```

`AGENTPING_PUSHDEER_KEY`, `AGENTPING_KEY`, and `PUSHDEER_KEY` override the Codex key. `AGENTPING_CLAUDE_PUSHDEER_KEY` and `CLAUDE_PUSHDEER_KEY` override the Claude key. Claude never falls back to the Codex key, so source separation is preserved.
`AGENTPING_CLAUDE_SUMMARY_MODEL` overrides the Claude summary model; the default is `haiku`.
`AGENTPING_SUMMARY_MODEL`, `AGENTPING_SUMMARY_MIN_CHARS`, `AGENTPING_SUMMARY_MAX_CHARS`, `AGENTPING_SUMMARY_FALLBACK_TEXT`, and `AGENTPING_LLM_TIMEOUT_MS` override the stored summary settings.
Summary length is prompt-guided, not hard-truncated. A slightly longer complete sentence is accepted, but an excessively long result or an apparent copy of the final answer is rejected. Timeout, command failure, empty output, and rejected output use `summaryFallbackText`, whose default is `摘要未生成，请看原回答`.
The summary model receives the full user prompt and full final answer so the generated notification title is based on complete context.
`AGENTPING_DESP_MAX_CHARS` overrides the stored `desp` truncation limit. The default is `-1`, which keeps the complete rendered `desp`; positive values are capped to 1000, and `0` omits `desp`.
`AGENTPING_DESP_SEPARATOR` overrides the marker placed before the original answer in `desp`; escaped `\n` sequences are converted to newlines. Set it to an empty string to omit the marker.
`AGENTPING_FINAL_WAIT_MS` controls how long a notify event waits for the Codex session file to show `task_complete`. Intermediate events are skipped if no completed final answer appears within that window.
`AGENTPING_NOTIFY_MODE` controls whether automatic notifications send. Valid values are `always`, `long_only`, `errors_only`, and `off`. The default is `long_only`.
`AGENTPING_MIN_DURATION_MS` is used by `long_only`; turns shorter than this threshold are skipped.
`AGENTPING_LOG_MAX_BYTES` and `AGENTPING_LOG_KEEP_FILES` control local log rotation. Set `AGENTPING_LOG_MAX_BYTES=0` to disable rotation.
`AGENTPING_DEBUG_LOGS=1` allows local logs to include redacted title/desp/stderr previews. By default logs keep operational metadata such as lengths, status, summary source, elapsed time, and errors.
`AGENTPING_TITLE_TEMPLATE` and `AGENTPING_DESP_TEMPLATE` customize PushDeer fields. Supported placeholders are `{summary}`, `{finalText}`, `{finalTextPreview}`, `{separator}`, `{duration}`, `{durationZh}`, `{turnId}`, `{terminalType}`, `{summarySource}`, `{summaryModel}`, and `{summaryElapsedMs}`.
`{duration}` is compact English-style timing such as `12.3s`; `{durationZh}` is Chinese minute/second timing such as `0分 12秒`.
`{finalTextPreview}` keeps approximately the first `finalTextPreviewHeadChars` characters and last `finalTextPreviewTailChars` characters, extending slightly when needed to end and begin at nearby punctuation boundaries. It inserts `finalTextPreviewMarker` between both sections.
`AGENTPING_PROJECT_CONFIG=/path/to/.agentping.json` forces a project config file; `AGENTPING_DISABLE_PROJECT_CONFIG=1` disables project config discovery.

Legacy `CODEX_PUSHDEER_*` variables and the old `~/.config/codex-pushdeer-notifier/config.json` config file are still read during migration. New writes go to `~/.config/agentping/config.json`.

## Manual Commands

Show PushDeer config status:

```bash
npm run config:show
agentping config show
agentping config set-key --platform codex --stdin
agentping config set-key --platform claude --stdin
agentping config set-summary-range 50 100
agentping config set-summary-fallback "摘要未生成，请看原回答"
agentping config set-timeout 15000
agentping config set-desp-max -1
agentping config set-separator "\n\n---\n\n"
agentping config set-mode long_only --min-duration-ms 10000
agentping config set-mode long_only --min-duration-ms 30000
agentping config set-mode off
agentping config set-debug-logs off
agentping config set-title-template "{summary}"
agentping config set-desp-template "用时：{durationZh}{separator}{finalTextPreview}"
agentping config reset-templates
agentping config init-project
```

Diagnose the whole local setup:

```bash
npm run doctor
```

Detect available summary models:

```bash
npm run check-models
npm run check-models -- --write-config
npm run check-models -- --benchmark --runs 3
npm run check-models -- --benchmark --write-fastest
```

Run a dry-run manual notification:

```bash
npm run notify:dry-run
```

Run the Claude adapter against the real Claude summary command without sending PushDeer, or add `--real` for a clearly labeled end-to-end test notification:

```bash
agentping test claude_live
agentping test claude_live --real
```

Inspect and manage local notifier logs:

```bash
agentping logs status
agentping logs summary
agentping logs tail 20
agentping logs rotate
agentping logs clear
```

Run local self-tests:

```bash
agentping test all
agentping test push --real
```

Validate the plugin structure:

```bash
npm run check
npm run plugin:validate
```

## Uninstall

```bash
node scripts/uninstall.mjs
```

This removes the installed Codex plugin, removes the Codex `notify` line only when it points at this checkout, and removes only AgentPing's handlers from Claude settings while preserving unrelated hooks.

To also remove both stored platform-specific PushDeer keys:

```bash
node scripts/uninstall.mjs --forget-key
```

To also remove the local marketplace source:

```bash
node scripts/uninstall.mjs --remove-marketplace
```

## Privacy And Security

Each automatic notification summarizes the latest user prompt and assistant answer through the corresponding local agent CLI. Codex notifications use a temporary `codex exec`; Claude notifications use a safe, non-persistent `claude --print` process with hooks and tools disabled. The summary text and configured answer preview are then sent to PushDeer.

Codex summary subprocesses reuse the normal Codex login but use an HTTPS-only provider profile. Claude summary subprocesses reuse the normal Claude Code authentication while `--safe-mode` prevents recursive hooks and project customizations.

The notifier redacts common PushDeer keys, OpenAI-style keys, bearer tokens, long URLs, and query token parameters before summarization and logging. This is a best-effort filter, not a complete data-loss-prevention system.

Local logs do not include full notification text, raw final answers, or summary command stderr unless `debugLogs`/`AGENTPING_DEBUG_LOGS=1` is enabled.

Do not install this notifier in environments where sending answer summaries to PushDeer is not allowed.

Never commit a PushDeer key to this repository.

## Distribution Notes

This repository includes a Codex marketplace at:

```text
.agents/plugins/marketplace.json
```

The marketplace exposes:

```text
agentping@agentping
```

For team distribution, ask users to clone this repository and run:

```bash
git clone https://github.com/planetInGalaxy/agentping.git
cd agentping
node scripts/install.mjs
```

Pin releases with Git tags such as `v0.5.0`.

## Troubleshooting

Run:

```bash
npm run doctor
```

Common failures:

- `codex` command missing: install or log into Codex CLI first.
- `claude` command missing: install or log into Claude Code first; Codex-only installation remains supported.
- `notify` mismatch: another notifier is configured in `~/.codex/config.toml`; rerun install with `--force-notify` only if replacement is intended.
- Codex or Claude PushDeer key missing: rerun the installer, or use `agentping config set-key --platform codex --stdin` and `agentping config set-key --platform claude --stdin`.
- Summary model unavailable: run `npm run check-models -- --write-config` or reinstall with `--summary-model <model>`.
- No Claude notification after install: run `agentping doctor`, then use Claude Code's `/hooks` view to confirm one AgentPing handler under both `Stop` and `StopFailure`.
- Old Codex task does not notify after install: run `node scripts/install.mjs --install-legacy-shim`, then finish the old task again. This only helps tasks that call `~/.codex/notify-multiplexer.mjs` at completion.
- Notification arrives for tasks you do not care about: use `agentping config set-mode long_only --min-duration-ms 30000` or `agentping config set-mode off`.
- Log file is too large: run `agentping logs rotate`, `agentping logs clear`, or reduce `logMaxBytes`.
- Need to debug summary timeouts: run `agentping check-models --benchmark --runs 3`. Benchmark attempts report transport, retry count, and timeout stage using the same HTTPS-only path as real notifications.
