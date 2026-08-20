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

// Matches the server→client request the real Copilot CLI sends when a
// session was created with `requestPermission: true` and the model wants to
// run a tool. The exact method name was never documented anywhere this
// plugin was built from (spec §6.3 names the RPC parameter, not the request
// it provokes), so this matches broadly on the vocabulary GitHub's other
// dotted RPC names use for this concept ("permission", "confirm", "approve")
// rather than a single hardcoded string.
const PERMISSION_REQUEST_METHOD_PATTERN = /permission|confirm|approv/i;

// Spec §6.3 layer 3 calls for "denying anything not on an explicit read
// allowlist" — not a blanket deny for every read-only permission request.
// git.mjs's self-collect path (git.mjs:8, >2 files) routes Copilot through
// exactly this: it is told to inspect the diff itself with read-only git
// commands, and a blanket deny turns that into a confident, paid review of
// a bare file list the model never actually read. This is deliberately a
// narrow, conservative allowlist of inspection commands rather than an
// attempt to sandbox arbitrary shell — anything that doesn't unambiguously
// match falls through to deny, which is the pre-existing, safe behaviour.
const READ_ONLY_COMMAND_ALLOWLIST =
  /^(git\s+(status|diff|log|show|ls-files)\b|ls|cat|rg|grep|find|head|tail|wc)(\s|$)/;

// Chaining/redirection characters that could smuggle a write past a command
// that otherwise starts with an allowed read-only verb (e.g.
// "git status; rm -rf ."). Any of these forces a deny regardless of the
// leading command.
const SHELL_CHAIN_PATTERN = /[;&|`]|\$\(|>/;

// The exact params shape a server permission request carries for a shell/
// tool command was never confirmed against the real protocol (see the
// PERMISSION_REQUEST_METHOD_PATTERN comment above), so this probes a small
// set of plausible field paths rather than assuming one. It returns a
// command string only when it finds one unambiguously; any shape it doesn't
// recognise returns null, which callers must treat as "cannot identify the
// command" — degrading to deny, never to allow.
function extractRequestedCommand(params) {
  if (!params || typeof params !== "object") {
    return null;
  }
  const candidates = [
    params.command,
    params.input?.command,
    params.arguments?.command,
    params.toolCall?.arguments?.command,
    params.tool?.input?.command,
    params.parameters?.command
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (Array.isArray(candidate) && candidate.length > 0 && candidate.every((part) => typeof part === "string")) {
      const joined = candidate.join(" ").trim();
      if (joined) {
        return joined;
      }
    }
  }
  return null;
}

function isAllowedReadOnlyCommand(command) {
  if (typeof command !== "string" || !command.trim()) {
    return false;
  }
  const trimmed = command.trim();
  if (SHELL_CHAIN_PATTERN.test(trimmed)) {
    return false;
  }
  return READ_ONLY_COMMAND_ALLOWLIST.test(trimmed);
}

// Answers a server permission request per spec §6.3 layer 3
// ("deny-by-default permissions... denying anything not on an explicit read
// allowlist"): a write-capable turn always allows; a read-only turn allows
// only when the requested command can be confidently identified and matches
// the read-only allowlist above, and denies otherwise (including when the
// command can't be identified at all — see extractRequestedCommand). The
// exact expected reply shape is unconfirmed against the real protocol (see
// the comment above), so this returns several differently-named
// boolean/string fields that cover the plausible shapes (`decision`,
// `approved`, `allow`, `behavior`) — harmless extra keys in a JSON-RPC
// result are ignored by a spec-conformant server, but a *missing* key the
// server actually reads would silently misbehave, which this hedges against
// until a live run confirms the real shape.
function buildPermissionResponse(readOnly, params) {
  const allow = !readOnly || isAllowedReadOnlyCommand(extractRequestedCommand(params));
  return {
    decision: allow ? "allow" : "deny",
    approved: allow,
    allow,
    behavior: allow ? "allow" : "deny"
  };
}

// Registered as the RPC client's server-request handler for the duration of
// a turn. Every server→client request must get a reply (see rpc-client.mjs);
// this is the policy for what that reply is. Anything that doesn't look like
// a permission request is refused explicitly (thrown, which rpc-client.mjs
// turns into a JSON-RPC error reply) rather than guessed at — an explicit
// refusal surfaces as a loud failure the server can act on, instead of a
// silently wrong answer.
function createServerRequestHandler({ readOnly, onProgress }) {
  return (message) => {
    const { method, params } = message;
    emit(onProgress, `Server request: ${method}`, "investigating", {
      logTitle: "Server request",
      logBody: JSON.stringify(params ?? {}, null, 2)
    });

    if (!PERMISSION_REQUEST_METHOD_PATTERN.test(String(method ?? ""))) {
      throw new Error(`Unsupported server request: ${method}`);
    }

    return buildPermissionResponse(readOnly, params);
  };
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

// See the call site in runCopilotTurn for why this exists: `assistant.usage`
// and `session.shutdown` were both empty against the real Copilot CLI, but
// `session.usage.getMetrics` returns real numbers when probed live. Failure
// here (unsupported method, closed client, etc.) must never throw — it is a
// best-effort supplement to the event-based capture, not a requirement.
async function fetchUsageMetrics(client, sessionId) {
  try {
    return await client.request("session.usage.getMetrics", { sessionId });
  } catch {
    return null;
  }
}

// `totalPremiumRequestCost` / `totalNanoAiu` take priority over the
// event-based numbers whenever the metrics call succeeded and returned a
// number — including 0, a legitimate value for a non-premium model — and
// fall back to whatever `assistant.usage` events already captured otherwise.
function mergeUsageMetrics(eventUsage, metrics) {
  if (!metrics) {
    return eventUsage;
  }
  const premiumRequests =
    typeof metrics.totalPremiumRequestCost === "number" ? metrics.totalPremiumRequestCost : eventUsage.premiumRequests;
  const aiu = typeof metrics.totalNanoAiu === "number" ? metrics.totalNanoAiu : eventUsage.aiu;
  return { ...eventUsage, premiumRequests, aiu };
}

// `codeChanges.filesModified` on session.usage.getMetrics is likely a more
// complete touched-files source than the `file.changed` event tracking, but
// its non-empty shape was never observed live (only an empty array was
// probed). Only prefer it when it is unambiguously a non-empty array of
// path strings — render.mjs interpolates each entry directly into a
// Markdown line, so anything else silently produces "- [object Object]".
// Otherwise keep the event-based list; this is a supplement, not a forced
// replacement.
function preferMetricsTouchedFiles(eventFiles, metrics) {
  const filesModified = metrics?.codeChanges?.filesModified;
  if (
    Array.isArray(filesModified) &&
    filesModified.length > 0 &&
    filesModified.every((entry) => typeof entry === "string")
  ) {
    return filesModified;
  }
  return eventFiles;
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
    // options.sessionId means "resume this EXISTING session" (session.resume).
    // options.newSessionId means "create a NEW session using THIS id"
    // (session.create) — used by background jobs, which mint a Copilot
    // session id before their worker exists so /copilot:cancel can target
    // it immediately. The real CLI rejects session.resume for an id it has
    // never created, so these two must route to different RPC calls.
    const sessionId = options.sessionId ?? options.newSessionId ?? randomUUID();
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

    // Spec §6.3 layer 3: with `requestPermission: true` below, the server
    // blocks each tool call on a reply to a server→client request. Without
    // this handler that request goes unanswered and the turn deadlocks
    // forever (see rpc-client.mjs's handleServerRequest for the transport
    // half of this fix).
    client.setServerRequestHandler(createServerRequestHandler({ readOnly: Boolean(options.readOnly), onProgress: options.onProgress }));

    if (resuming) {
      // Fix M2/M3: emit copilotSessionId alongside the progress message so
      // it reaches the job record (tracked-jobs.mjs's progress updater only
      // writes copilotSessionId when a progress event carries one) — without
      // it, /copilot:cancel's interruptCopilotTurn call is always a no-op
      // during a running job. Also pass model/reasoningEffort on resume,
      // mirroring the create branch below: a previous ruling verified
      // against the real Copilot CLI that session.resume accepts these
      // extra params without error, and render.mjs prints the resolved
      // model's multiplier regardless of which branch ran, so omitting them
      // here silently billed at the resumed session's original model while
      // printing the multiplier for whatever --model was requested instead.
      emit(options.onProgress, `Resuming session ${sessionId}.`, "starting", { copilotSessionId: sessionId });
      await client.request("session.resume", {
        sessionId,
        workingDirectory: cwd,
        model: options.model,
        ...(options.effort ? { reasoningEffort: options.effort } : {}),
        ...(options.readOnly ? { excludedTools: READ_ONLY_EXCLUDED_TOOLS } : {}),
        requestPermission: Boolean(options.readOnly)
      });
    } else {
      emit(options.onProgress, "Creating Copilot session.", "starting", { copilotSessionId: sessionId });
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

    // Fix C (Task 16 follow-up): `assistant.usage` events and `session.shutdown`
    // (which only fires on session.destroy, which this function never calls)
    // both returned nothing against the real Copilot CLI — every real turn in
    // acceptance testing came back with usage.premiumRequests: null.
    // `session.usage.getMetrics` was probed live and does return real numbers,
    // so query it once the turn has resolved, before the client closes. This
    // is additive: if the query fails (e.g. the test fixture doesn't implement
    // it, or an older CLI predates this RPC), the event-based capture.usage
    // stays exactly as it was.
    const metrics = await fetchUsageMetrics(client, sessionId);

    return {
      status: capture.error ? 1 : 0,
      sessionId,
      mode,
      messageId: send?.messageId ?? null,
      finalMessage: capture.finalMessage,
      reasoningSummary: capture.reasoning,
      touchedFiles: preferMetricsTouchedFiles([...capture.touchedFiles], metrics),
      commandExecutions: capture.commandExecutions,
      usage: { ...mergeUsageMetrics(capture.usage, metrics), model: options.model },
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
