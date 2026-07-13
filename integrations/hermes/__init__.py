"""Hermes adapter for the local AgentPing worker."""

import json
import os
import pathlib
import subprocess
import time

_started = {}


def _ingest_script():
    configured = os.environ.get("AGENTPING_INGEST_SCRIPT")
    if configured:
        return pathlib.Path(configured).expanduser()
    return pathlib.Path.home() / ".local/share/agentping/current/plugins/agentping/scripts/agentping-ingest.mjs"


def _before(session_id="", **kwargs):
    _started[str(session_id)] = time.monotonic()


def _after(session_id="", user_message="", assistant_response="", model="", platform="", **kwargs):
    if os.environ.get("AGENTPING_SUPPRESS_NOTIFY") == "1" or os.environ.get("CODEX_PUSHDEER_SUPPRESS_NOTIFY") == "1":
        return
    final_text = str(assistant_response or "").strip()
    if not final_text:
        return
    started = _started.pop(str(session_id), None)
    duration_ms = round((time.monotonic() - started) * 1000) if started is not None else None
    usage = kwargs.get("usage") or kwargs.get("token_usage") or kwargs.get("usage_metadata")
    if hasattr(usage, "model_dump"):
        usage = usage.model_dump()
    elif hasattr(usage, "dict"):
        usage = usage.dict()
    if not isinstance(usage, dict):
        usage = {}
    event = {
        "agentId": "hermes",
        "agentType": "hermes",
        "sessionId": str(session_id or ""),
        "status": "success",
        "terminalType": "task_complete",
        "durationMs": duration_ms,
        "userText": str(user_message or "").strip(),
        "finalText": final_text,
        "model": str(model or ""),
        "provider": str(kwargs.get("provider") or ""),
        "usage": usage or None,
        "cwd": os.getcwd(),
        "metadata": {"sourceHook": "post_llm_call", "platform": str(platform or "")},
    }
    script = _ingest_script()
    if not script.is_file():
        return
    try:
        subprocess.Popen(
            ["node", str(script), json.dumps(event, ensure_ascii=False)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return


def register(ctx):
    ctx.register_hook("pre_llm_call", _before)
    ctx.register_hook("post_llm_call", _after)
