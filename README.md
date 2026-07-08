# Codex PushDeer Notifier

Send a PushDeer notification after each Codex turn completes. The PushDeer `text` field is a short LLM-generated summary of the full assistant answer. The `desp` field contains a separator marker followed by the original assistant answer truncated to a configurable maximum length. If the summary model fails or times out, the notifier falls back to the first 50 characters of the final answer for `text`.

The notifier uses Codex `notify` with the `agent-turn-complete` event. It does not rely on Codex Stop hooks for normal operation.

## What It Does

- Runs after a Codex answer is complete.
- Summarizes the full user question and assistant answer with `codex exec`.
- Sends the summary in PushDeer `text`.
- Sends a separator plus the original assistant answer in PushDeer `desp`, truncated to `despMaxChars`.
- Keeps the default summary at or below 60 characters.
- Keeps the default `desp` at or below 300 characters.
- Stores each user's PushDeer key outside the repository.
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
git clone https://github.com/planetInGalaxy/ai-email.git
cd ai-email
node scripts/install.mjs
```

The installer will:

- Add this repository as a local Codex plugin marketplace named `codex-pushdeer`.
- Install `codex-pushdeer-notifier@codex-pushdeer`.
- Configure the top-level Codex `notify` entry in `~/.codex/config.toml`.
- Detect and store an available Codex summary model.
- Prompt for a PushDeer key if one is not already configured.

To pass the key non-interactively:

```bash
PUSHDEER_KEY='PDU...' node scripts/install.mjs
```

To send a real PushDeer test notification during setup:

```bash
PUSHDEER_KEY='PDU...' node scripts/install.mjs --test
```

To preview what the installer would do without changing local files:

```bash
node scripts/install.mjs --dry-run --skip-key
```

Useful install flags:

```bash
node scripts/install.mjs --summary-model gpt-5.5
node scripts/install.mjs --llm-timeout-ms 15000
node scripts/install.mjs --desp-max-chars 300
node scripts/install.mjs --desp-separator "\n-----\n"
node scripts/install.mjs --no-desp
node scripts/install.mjs --no-desp-separator
node scripts/install.mjs --skip-model-check
node scripts/install.mjs --force-notify
```

After installation, start a new Codex thread or restart Codex.

## Package-Style Usage

This repository is npm-package ready and exposes a `codex-pushdeer` command. After publishing to npm, users should install it globally so Codex `notify` points at a stable script path:

```bash
npm install -g codex-pushdeer-notifier
codex-pushdeer install
```

Until it is published to npm, use the clone-based install above.

## Existing Notify Config

Codex supports a user-level `notify` command in `~/.codex/config.toml`. If the installer detects an existing top-level `notify`, it will ask before replacing it.

For non-interactive installs that should replace the existing notifier:

```bash
node scripts/install.mjs --force-notify
```

If you already use another notifier, do not force overwrite unless replacing it is intended.

## Configuration Files

The PushDeer key is saved here:

```text
~/.config/codex-pushdeer-notifier/config.json
```

The Codex notify command is written here:

```text
~/.codex/config.toml
```

The installer writes a line like this:

```toml
notify = ["node", "/absolute/path/to/codex-pushdeer-notifier/plugins/codex-pushdeer-notifier/scripts/pushdeer-notify-event.mjs"]
```

The notifier config stores local runtime settings:

```json
{
  "pushkey": "PDU...",
  "endpoint": "https://api2.pushdeer.com/message/push",
  "summaryModel": "gpt-5.4-mini",
  "llmTimeoutMs": 12000,
  "despMaxChars": 300,
  "despSeparator": "\n-----\n"
}
```

## Runtime Settings

Optional environment variables:

```bash
export CODEX_PUSHDEER_SUMMARY_MODEL=gpt-5.4-mini
export CODEX_PUSHDEER_LLM_TIMEOUT_MS=12000
export CODEX_PUSHDEER_DESP_MAX_CHARS=300
export CODEX_PUSHDEER_DESP_SEPARATOR='\n-----\n'
export CODEX_PUSHDEER_ENDPOINT=https://api2.pushdeer.com/message/push
export CODEX_PUSHDEER_KEY='PDU...'
```

`CODEX_PUSHDEER_KEY` and `PUSHDEER_KEY` override the stored config key.
`CODEX_PUSHDEER_SUMMARY_MODEL` and `CODEX_PUSHDEER_LLM_TIMEOUT_MS` override the stored summary settings.
`CODEX_PUSHDEER_DESP_MAX_CHARS` overrides the stored `desp` truncation limit. Values above 300 are capped to 300. Set it to `0` to omit `desp`.
`CODEX_PUSHDEER_DESP_SEPARATOR` overrides the marker placed before the original answer in `desp`; escaped `\n` sequences are converted to newlines. Set it to an empty string to omit the marker.

## Manual Commands

Show PushDeer config status:

```bash
npm run config:show
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
codex-pushdeer-notifier@codex-pushdeer
```

For team distribution, ask users to clone this repository and run:

```bash
git clone https://github.com/planetInGalaxy/ai-email.git
cd ai-email
node scripts/install.mjs
```

Pin releases with Git tags such as `v0.2.2`.

## Troubleshooting

Run:

```bash
npm run doctor
```

Common failures:

- `codex` command missing: install or log into Codex CLI first.
- `notify` mismatch: another notifier is configured in `~/.codex/config.toml`; rerun install with `--force-notify` only if replacement is intended.
- PushDeer key missing: run `PUSHDEER_KEY='PDU...' node scripts/install.mjs`.
- Summary model unavailable: run `npm run check-models -- --write-config` or reinstall with `--summary-model <model>`.
- No notification after install: restart Codex or start a new Codex thread.
