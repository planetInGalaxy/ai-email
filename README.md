# AgentPing

AgentPing sends concise completion summaries when your AI agents finish.

It currently supports Codex completion events and PushDeer delivery. The PushDeer `text` field is a short LLM-generated summary of the full assistant answer. The `desp` field contains a separator marker followed by the original assistant answer truncated to a configurable maximum length. If the summary model fails or times out, AgentPing falls back to a complete short sentence or a generic completion notice for `text`.

AgentPing uses Codex `notify` with the `agent-turn-complete` event. It does not rely on Codex Stop hooks for normal operation.

## What It Does

- Runs after a Codex answer is complete.
- Ignores intermediate commentary/status messages and waits for Codex session `task_complete`.
- Summarizes the full user question and assistant answer with `codex exec`.
- Sends the summary in PushDeer `text`.
- Sends a separator plus the original assistant answer in PushDeer `desp`, truncated to `despMaxChars`.
- Asks the summary model for 30 to 60 Chinese characters by default.
- Does not hard-truncate LLM summaries; semantic completeness is preferred if the model slightly exceeds the configured range.
- Keeps the default `desp` at or below 300 characters.
- Supports notification modes: always, long tasks only, errors only, or off.
- Rotates local notifier logs so troubleshooting data does not grow without bound.
- Includes local self-test commands that use temporary files and dry-run PushDeer sends.
- Stores each user's PushDeer key outside the repository.
- Keeps compatibility with the old `codex-pushdeer` CLI and `CODEX_PUSHDEER_*` environment variables during migration.
- Treats notification failures as non-blocking for the original Codex task.

## Requirements

- macOS or Linux with Node.js available as `node`.
- Codex CLI available as `codex`.
- A PushDeer `pushkey`.
- Access to at least one Codex model for summary generation.

The installer detects available Codex models with `codex debug models` and stores the selected summary model in local config. If you want to force a model, pass it during install:

```bash
node scripts/install.mjs --summary-model gpt-5.5
```

## Install

Clone this repository, then run the installer:

```bash
git clone https://github.com/planetInGalaxy/agentping.git
cd agentping
node scripts/install.mjs
```

The installer will:

- Add this repository as a local Codex plugin marketplace named `agentping`.
- Install `agentping@agentping`.
- Configure the top-level Codex `notify` entry in `~/.codex/config.toml`.
- Detect and store an available Codex summary model.
- Prompt for a PushDeer key if one is not already configured.

To pass the key non-interactively:

```bash
AGENTPING_PUSHDEER_KEY='PDU...' node scripts/install.mjs
```

To send a real PushDeer test notification during setup:

```bash
AGENTPING_PUSHDEER_KEY='PDU...' node scripts/install.mjs --test
```

To preview what the installer would do without changing local files:

```bash
node scripts/install.mjs --dry-run --skip-key
```

Useful install flags:

```bash
node scripts/install.mjs --summary-model gpt-5.5
node scripts/install.mjs --summary-min-chars 30 --summary-max-chars 60
node scripts/install.mjs --llm-timeout-ms 15000
node scripts/install.mjs --desp-max-chars 300
node scripts/install.mjs --desp-separator "\n-----\n"
node scripts/install.mjs --final-wait-ms 8000
node scripts/install.mjs --notify-mode always
node scripts/install.mjs --notify-mode long_only --min-duration-ms 30000
node scripts/install.mjs --log-max-bytes 2097152 --log-keep-files 3
node scripts/install.mjs --no-desp
node scripts/install.mjs --no-desp-separator
node scripts/install.mjs --skip-model-check
node scripts/install.mjs --force-notify
```

After installation, start a new Codex thread or restart Codex.

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

For non-interactive installs that should replace the existing notifier:

```bash
node scripts/install.mjs --force-notify
```

If you already use another notifier, do not force overwrite unless replacing it is intended.

## Configuration Files

The PushDeer key is saved here:

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

The notifier config stores local runtime settings:

```json
{
  "pushkey": "PDU...",
  "endpoint": "https://api2.pushdeer.com/message/push",
  "summaryModel": "gpt-5.4-mini",
  "summaryMinChars": 30,
  "summaryMaxChars": 60,
  "llmTimeoutMs": 12000,
  "despMaxChars": 300,
  "despSeparator": "\n-----\n",
  "finalWaitMs": 8000,
  "notifyMode": "always",
  "minDurationMs": 30000,
  "logMaxBytes": 2097152,
  "logKeepFiles": 3
}
```

## Runtime Settings

Optional environment variables:

```bash
export AGENTPING_SUMMARY_MODEL=gpt-5.4-mini
export AGENTPING_SUMMARY_MIN_CHARS=30
export AGENTPING_SUMMARY_MAX_CHARS=60
export AGENTPING_LLM_TIMEOUT_MS=12000
export AGENTPING_DESP_MAX_CHARS=300
export AGENTPING_DESP_SEPARATOR='\n-----\n'
export AGENTPING_FINAL_WAIT_MS=8000
export AGENTPING_NOTIFY_MODE=always
export AGENTPING_MIN_DURATION_MS=30000
export AGENTPING_LOG_MAX_BYTES=2097152
export AGENTPING_LOG_KEEP_FILES=3
export AGENTPING_PUSHDEER_ENDPOINT=https://api2.pushdeer.com/message/push
export AGENTPING_PUSHDEER_KEY='PDU...'
```

`AGENTPING_PUSHDEER_KEY`, `AGENTPING_KEY`, and `PUSHDEER_KEY` override the stored config key.
`AGENTPING_SUMMARY_MODEL`, `AGENTPING_SUMMARY_MIN_CHARS`, `AGENTPING_SUMMARY_MAX_CHARS`, and `AGENTPING_LLM_TIMEOUT_MS` override the stored summary settings.
Summary length is prompt-guided, not enforced by hard truncation. If the model returns a slightly longer complete sentence, the notifier sends it as-is.
`AGENTPING_DESP_MAX_CHARS` overrides the stored `desp` truncation limit. Values above 300 are capped to 300. Set it to `0` to omit `desp`.
`AGENTPING_DESP_SEPARATOR` overrides the marker placed before the original answer in `desp`; escaped `\n` sequences are converted to newlines. Set it to an empty string to omit the marker.
`AGENTPING_FINAL_WAIT_MS` controls how long a notify event waits for the Codex session file to show `task_complete`. Intermediate events are skipped if no completed final answer appears within that window.
`AGENTPING_NOTIFY_MODE` controls whether automatic notifications send. Valid values are `always`, `long_only`, `errors_only`, and `off`. The default is `always`.
`AGENTPING_MIN_DURATION_MS` is used by `long_only`; turns shorter than this threshold are skipped.
`AGENTPING_LOG_MAX_BYTES` and `AGENTPING_LOG_KEEP_FILES` control local log rotation. Set `AGENTPING_LOG_MAX_BYTES=0` to disable rotation.

Legacy `CODEX_PUSHDEER_*` variables and the old `~/.config/codex-pushdeer-notifier/config.json` config file are still read during migration. New writes go to `~/.config/agentping/config.json`.

## Manual Commands

Show PushDeer config status:

```bash
npm run config:show
agentping config show
agentping config set-summary-range 30 60
agentping config set-timeout 15000
agentping config set-desp-max 300
agentping config set-separator "\n-----\n"
agentping config set-mode always
agentping config set-mode long_only --min-duration-ms 30000
agentping config set-mode off
```

Diagnose the whole local setup:

```bash
npm run doctor
```

Detect available summary models:

```bash
npm run check-models
npm run check-models -- --write-config
```

Run a dry-run manual notification:

```bash
npm run notify:dry-run
```

Inspect and manage local notifier logs:

```bash
agentping logs status
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

This removes the installed plugin and removes the Codex `notify` line only when it points at this checkout.

To also remove the stored PushDeer key:

```bash
node scripts/uninstall.mjs --forget-key
```

To also remove the local marketplace source:

```bash
node scripts/uninstall.mjs --remove-marketplace
```

## Privacy And Security

Each automatic notification summarizes the latest user prompt and assistant answer by launching a temporary `codex exec` process. The summary text is then sent to PushDeer.

The notifier redacts common PushDeer keys, OpenAI-style keys, bearer tokens, long URLs, and query token parameters before summarization and logging. This is a best-effort filter, not a complete data-loss-prevention system.

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

Pin releases with Git tags such as `v0.4.1`.

## Troubleshooting

Run:

```bash
npm run doctor
```

Common failures:

- `codex` command missing: install or log into Codex CLI first.
- `notify` mismatch: another notifier is configured in `~/.codex/config.toml`; rerun install with `--force-notify` only if replacement is intended.
- PushDeer key missing: run `AGENTPING_PUSHDEER_KEY='PDU...' node scripts/install.mjs`.
- Summary model unavailable: run `npm run check-models -- --write-config` or reinstall with `--summary-model <model>`.
- No notification after install: restart Codex or start a new Codex thread.
- Notification arrives for tasks you do not care about: use `agentping config set-mode long_only --min-duration-ms 30000` or `agentping config set-mode off`.
- Log file is too large: run `agentping logs rotate`, `agentping logs clear`, or reduce `logMaxBytes`.
