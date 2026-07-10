import path from "node:path";

export function notifyCommandForScript(notifyScript) {
  return ["node", notifyScript];
}

export function notifyLineForCommand(command) {
  return `notify = ${JSON.stringify(command)}`;
}

export function parseNotifyCommandLine(line) {
  const match = String(line || "").match(/^\s*notify\s*=\s*(.+?)\s*$/u);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function findTopLevelNotify(contents) {
  const lines = String(contents || "").split(/\r?\n/);
  let firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTableIndex === -1) firstTableIndex = lines.length;

  for (let i = 0; i < firstTableIndex; i += 1) {
    if (/^\s*notify\s*=/.test(lines[i])) {
      return {
        lines,
        index: i,
        firstTableIndex,
        line: lines[i],
        command: parseNotifyCommandLine(lines[i]),
      };
    }
  }

  return {
    lines,
    index: -1,
    firstTableIndex,
    line: "",
    command: null,
  };
}

function normalizedScriptPath(value) {
  if (!value) return "";
  return path.resolve(String(value));
}

export function commandTargetsScript(command, notifyScript) {
  return Array.isArray(command) &&
    command.length >= 2 &&
    normalizedScriptPath(command[1]) === normalizedScriptPath(notifyScript);
}

function commandEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commandContainsFragment(command, fragment) {
  return Array.isArray(command) &&
    command.some((item) => String(item).includes(fragment));
}

export function commandMatchesLegacy(command, legacyCommands = [], legacyPathFragments = []) {
  return legacyCommands.some((legacyCommand) => commandEquals(command, legacyCommand)) ||
    legacyPathFragments.some((fragment) => commandContainsFragment(command, fragment));
}

export function parsePreviousNotify(command) {
  if (!Array.isArray(command)) {
    return {
      index: -1,
      raw: "",
      command: null,
      parseError: false,
    };
  }

  const index = command.indexOf("--previous-notify");
  if (index === -1) {
    return {
      index: -1,
      raw: "",
      command: null,
      parseError: false,
    };
  }

  const raw = command[index + 1] || "";
  try {
    const parsed = JSON.parse(raw);
    return {
      index,
      raw,
      command: Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
        ? parsed
        : null,
      parseError: false,
    };
  } catch {
    return {
      index,
      raw,
      command: null,
      parseError: true,
    };
  }
}

function replaceLine(lines, index, command) {
  const next = [...lines];
  next[index] = notifyLineForCommand(command);
  return next.join("\n").replace(/\n*$/u, "\n");
}

export function replaceTopLevelNotify(contents, {
  desiredCommand,
  legacyCommands = [],
  legacyPathFragments = [],
  force = false,
} = {}) {
  const target = findTopLevelNotify(contents);
  const replacementLine = notifyLineForCommand(desiredCommand);

  if (target.index === -1) {
    const lines = [...target.lines];
    lines.splice(target.firstTableIndex, 0, replacementLine, "");
    return {
      contents: lines.join("\n").replace(/\n*$/u, "\n"),
      changed: true,
      reason: "notify inserted",
    };
  }

  if (!target.command) {
    if (!force) {
      return {
        contents,
        changed: false,
        conflict: target.line.trim(),
        reason: "notify could not be parsed",
      };
    }

    return {
      contents: replaceLine(target.lines, target.index, desiredCommand),
      changed: true,
      reason: "unparseable notify replaced",
    };
  }

  if (commandEquals(target.command, desiredCommand)) {
    return { contents, changed: false, reason: "notify already configured" };
  }

  if (commandMatchesLegacy(target.command, legacyCommands, [])) {
    return {
      contents: replaceLine(target.lines, target.index, desiredCommand),
      changed: true,
      reason: "legacy notify replaced",
    };
  }

  const previous = parsePreviousNotify(target.command);
  if (previous.index !== -1) {
    if (commandEquals(previous.command, desiredCommand)) {
      return {
        contents,
        changed: false,
        reason: "wrapped notify already delegates to AgentPing",
      };
    }

    if (force || commandMatchesLegacy(previous.command, legacyCommands, legacyPathFragments)) {
      const nextCommand = [...target.command];
      nextCommand[previous.index + 1] = JSON.stringify(desiredCommand);
      return {
        contents: replaceLine(target.lines, target.index, nextCommand),
        changed: true,
        reason: commandMatchesLegacy(previous.command, legacyCommands, legacyPathFragments)
          ? "legacy wrapped notify replaced"
          : "wrapped notify replaced",
      };
    }

    return {
      contents,
      changed: false,
      conflict: target.line.trim(),
      previousNotify: previous.raw,
      reason: previous.parseError
        ? "wrapped previous notify could not be parsed"
        : "wrapped previous notify points elsewhere",
    };
  }

  if (commandMatchesLegacy(target.command, legacyCommands, legacyPathFragments)) {
    return {
      contents: replaceLine(target.lines, target.index, desiredCommand),
      changed: true,
      reason: "legacy notify replaced",
    };
  }

  if (!force) {
    return {
      contents,
      changed: false,
      conflict: target.line.trim(),
      reason: "different notify configured",
    };
  }

  return {
    contents: replaceLine(target.lines, target.index, desiredCommand),
    changed: true,
    reason: "notify replaced",
  };
}

export function notifyConfigStatus(contents, {
  desiredCommand,
  notifyScript,
  legacyCommands = [],
  legacyPathFragments = [],
} = {}) {
  const target = findTopLevelNotify(contents);
  if (target.index === -1) {
    return {
      ok: false,
      detail: "top-level notify is not configured",
    };
  }

  if (!target.command) {
    return {
      ok: false,
      detail: `notify could not be parsed: ${target.line.trim()}`,
    };
  }

  if (commandEquals(target.command, desiredCommand) || commandTargetsScript(target.command, notifyScript)) {
    return {
      ok: true,
      detail: "notify points at this checkout",
    };
  }

  if (commandMatchesLegacy(target.command, legacyCommands, [])) {
    return {
      ok: false,
      detail: `notify still points at a legacy AgentPing/Codex PushDeer command: ${target.line.trim()}`,
    };
  }

  const previous = parsePreviousNotify(target.command);
  if (previous.index !== -1) {
    if (commandEquals(previous.command, desiredCommand) || commandTargetsScript(previous.command, notifyScript)) {
      return {
        ok: true,
        detail: "notify wrapper delegates to this checkout",
      };
    }

    if (commandMatchesLegacy(previous.command, legacyCommands, legacyPathFragments)) {
      return {
        ok: false,
        detail: `notify wrapper still delegates to a legacy AgentPing/Codex PushDeer command: ${previous.raw}`,
      };
    }

    return {
      ok: false,
      detail: previous.parseError
        ? `notify wrapper has an unparseable previous notify: ${previous.raw}`
        : `notify wrapper delegates elsewhere: ${previous.raw}`,
    };
  }

  if (commandMatchesLegacy(target.command, legacyCommands, legacyPathFragments)) {
    return {
      ok: false,
      detail: `notify still points at a legacy AgentPing/Codex PushDeer command: ${target.line.trim()}`,
    };
  }

  return {
    ok: false,
    detail: `different notify configured: ${target.line.trim()}`,
  };
}
