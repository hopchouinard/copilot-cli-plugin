import { randomUUID } from "node:crypto";

import { CopilotRpcClient } from "./rpc-client.mjs";
import { normalizeCatalog } from "./models.mjs";
import { binaryAvailable } from "./process.mjs";

export const TASK_SESSION_PREFIX = "Copilot Companion Task";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

const READ_ONLY_EXCLUDED_TOOLS = ["write", "edit", "str_replace_editor", "create_file", "apply_patch"];
const INFERRED_COMPLETION_MS = 250;
const NOT_INSTALLED =
  "GitHub Copilot CLI is not installed or is too old. Install it with `npm install -g @github/copilot`, then rerun `/copilot:setup`.";

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

function emit(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  onProgress({ message, phase, ...extra });
}

async function withClient(cwd, options, fn) {
  const client = await CopilotRpcClient.connect(cwd, {
    binary: options.binary,
    env: options.env
  });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export function getCopilotAvailability(cwd, options = {}) {
  const binary = options.binary ?? "copilot";
  const version = binaryAvailable(binary, ["--version"], { cwd });
  if (!version.available) {
    return { available: false, detail: version.detail, version: null };
  }
  return { available: true, detail: version.detail, version: version.detail };
}

export async function getCopilotAuthStatus(cwd, options = {}) {
  try {
    return await withClient(cwd, options, async (client) => {
      const status = await client.request("auth.getStatus", {});
      return {
        available: true,
        loggedIn: Boolean(status?.isAuthenticated),
        detail: status?.statusMessage ?? (status?.isAuthenticated ? "authenticated" : "not authenticated"),
        authType: status?.authType ?? null,
        login: status?.login ?? null,
        host: status?.host ?? null
      };
    });
  } catch (error) {
    return {
      available: false,
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      authType: null,
      login: null,
      host: null
    };
  }
}

export async function fetchModelCatalog(cwd, options = {}) {
  return withClient(cwd, options, async (client) => normalizeCatalog(await client.request("models.list", {})));
}

function createCapture(sessionId, onProgress) {
  return {
    sessionId,
    onProgress,
    buffered: [],
    started: false,
    finalMessage: "",
    reasoning: [],
    touchedFiles: new Set(),
    commandExecutions: [],
    usage: { premiumRequests: null, aiu: null },
    error: null,
    completed: false,
    sawMessage: false,
    timer: null,
    resolve: null,
    promise: null
  };
}

function scheduleInferredCompletion(capture) {
  if (capture.completed || !capture.sawMessage) {
    return;
  }
  clearTimeout(capture.timer);
  capture.timer = setTimeout(() => {
    if (!capture.completed && capture.sawMessage) {
      capture.completed = true;
      capture.resolve();
    }
  }, INFERRED_COMPLETION_MS);
  capture.timer.unref?.();
}

function applyEvent(capture, event) {
  const data = event?.data ?? {};

  switch (event?.type) {
    case "session.start":
      emit(capture.onProgress, "Session ready.", "starting");
      break;
    case "assistant.turn_start":
      emit(capture.onProgress, "Turn started.", "starting");
      break;
    case "assistant.reasoning": {
      const text = String(data.text ?? data.summary ?? "").trim();
      if (text) {
        capture.reasoning.push(text);
        emit(capture.onProgress, `Reasoning: ${shorten(text)}`, "investigating", {
          logTitle: "Reasoning summary",
          logBody: text
        });
      }
      break;
    }
    case "command.execute":
      emit(
        capture.onProgress,
        `Running command: ${shorten(data.command)}`,
        looksLikeVerificationCommand(data.command) ? "verifying" : "running"
      );
      break;
    case "command.completed":
      capture.commandExecutions.push(data);
      emit(
        capture.onProgress,
        `Command completed: ${shorten(data.command)} (exit ${data.exitCode ?? "?"})`,
        looksLikeVerificationCommand(data.command) ? "verifying" : "running"
      );
      break;
    case "assistant.tool_call_delta":
      emit(capture.onProgress, `Tool call: ${shorten(data.name ?? data.tool)}`, "investigating");
      break;
    case "file.changed":
      if (data.path) {
        capture.touchedFiles.add(data.path);
      }
      break;
    case "assistant.message": {
      const content = String(data.content ?? data.text ?? "").trim();
      if (content) {
        capture.finalMessage = content;
        capture.sawMessage = true;
        emit(capture.onProgress, `Assistant message captured: ${shorten(content)}`, "finalizing", {
          logTitle: "Assistant message",
          logBody: content
        });
        scheduleInferredCompletion(capture);
      }
      break;
    }
    case "assistant.usage":
      if (typeof data.premiumRequests === "number") {
        capture.usage.premiumRequests = data.premiumRequests;
      }
      break;
    case "assistant.turn_end":
      clearTimeout(capture.timer);
      if (!capture.completed) {
        capture.completed = true;
        emit(capture.onProgress, "Turn completed.", "finalizing");
        capture.resolve();
      }
      break;
    case "session.shutdown":
      if (typeof data.totalPremiumRequests === "number") {
        capture.usage.premiumRequests = data.totalPremiumRequests;
      }
      if (typeof data.totalNanoAiu === "number") {
        capture.usage.aiu = data.totalNanoAiu;
      }
      break;
    case "error":
      capture.error = data;
      emit(capture.onProgress, `Copilot error: ${data.message ?? "unknown"}`, "failed");
      break;
    default:
      break;
  }
}

export async function runCopilotTurn(cwd, options = {}) {
  const availability = getCopilotAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(NOT_INSTALLED);
  }

  if (!options.model) {
    throw new Error("runCopilotTurn requires an explicitly resolved model.");
  }

  return withClient(cwd, options, async (client) => {
    const sessionId = options.sessionId ?? randomUUID();
    const resuming = Boolean(options.sessionId);

    const capture = createCapture(sessionId, options.onProgress);
    capture.promise = new Promise((resolve) => {
      capture.resolve = resolve;
    });

    client.setNotificationHandler((message) => {
      if (message.method !== "session.event" || message.params?.sessionId !== sessionId) {
        return;
      }
      if (!capture.started) {
        capture.buffered.push(message.params.event);
        return;
      }
      applyEvent(capture, message.params.event);
    });

    if (resuming) {
      emit(options.onProgress, `Resuming session ${sessionId}.`, "starting");
      await client.request("session.resume", { sessionId, workingDirectory: cwd });
    } else {
      emit(options.onProgress, "Creating Copilot session.", "starting");
      await client.request("session.create", {
        sessionId,
        workingDirectory: cwd,
        model: options.model,
        ...(options.effort ? { reasoningEffort: options.effort } : {}),
        ...(options.readOnly ? { excludedTools: READ_ONLY_EXCLUDED_TOOLS } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        enableFileChangeTracking: true,
        streaming: false,
        requestPermission: Boolean(options.readOnly),
        clientName: "claude-code-copilot-plugin"
      });

      if (options.sessionName) {
        await client.request("session.name.set", { sessionId, name: options.sessionName }).catch(() => {});
      }
    }

    const mode = options.readOnly ? "plan" : "interactive";
    await client.request("session.mode.set", { sessionId, mode });
    if (!options.readOnly) {
      await client.request("session.permissions.setAllowAll", { sessionId, enabled: true }).catch(() => {});
    }

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Copilot run.");
    }

    const send = await client.request("session.send", { sessionId, prompt });

    capture.started = true;
    for (const event of capture.buffered) {
      applyEvent(capture, event);
    }
    capture.buffered.length = 0;

    await capture.promise;

    return {
      status: capture.error ? 1 : 0,
      sessionId,
      mode,
      messageId: send?.messageId ?? null,
      finalMessage: capture.finalMessage,
      reasoningSummary: capture.reasoning,
      touchedFiles: [...capture.touchedFiles],
      commandExecutions: capture.commandExecutions,
      usage: { ...capture.usage, model: options.model },
      error: capture.error,
      stderr: client.stderr
    };
  });
}

export async function interruptCopilotTurn(cwd, { sessionId }, options = {}) {
  if (!sessionId) {
    return { attempted: false, interrupted: false, detail: "missing sessionId" };
  }

  try {
    return await withClient(cwd, options, async (client) => {
      try {
        await client.request("session.interruptMainTurn", { sessionId });
      } catch {
        await client.request("session.abort", { sessionId });
      }
      return { attempted: true, interrupted: true, detail: `Interrupted ${sessionId}.` };
    });
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function findLatestTaskSession(cwd, options = {}) {
  return withClient(cwd, options, async (client) => {
    const response = await client.request("sessions.list", { limit: 20 });
    const match = (response?.sessions ?? []).find(
      (session) =>
        typeof session.name === "string" &&
        session.name.startsWith(TASK_SESSION_PREFIX) &&
        (!session.context?.cwd || session.context.cwd === cwd)
    );
    return match ? { sessionId: match.sessionId } : null;
  });
}

export function buildTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Copilot did not return a final message.",
      rawOutput: ""
    };
  }

  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(text);
  const candidate = fenced ? fenced[1] : text;

  try {
    return { parsed: JSON.parse(candidate), parseError: null, rawOutput: text };
  } catch (error) {
    return { parsed: null, parseError: error.message, rawOutput: text };
  }
}
