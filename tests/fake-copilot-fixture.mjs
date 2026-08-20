#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

import { encodeMessage, createMessageDecoder } from "../plugins/copilot/scripts/lib/rpc-client.mjs";

const scenario = process.env.FAKE_COPILOT_SCRIPT
  ? JSON.parse(fs.readFileSync(process.env.FAKE_COPILOT_SCRIPT, "utf8"))
  : {};

const DEFAULT_MODELS = [
  { id: "auto", name: "Auto", capabilities: {}, billing: { discountPercent: 10 } },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "max"] } },
    billing: { multiplier: 9 }
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    capabilities: { supports: {} },
    billing: { multiplier: 0.33 }
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
    billing: { multiplier: 6 }
  }
];

function send(message) {
  process.stdout.write(encodeMessage(message));
}

function emitEvent(sessionId, event) {
  send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event } });
}

// Records every RPC call the fixture receives, keyed by method, so tests
// running in a separate process can assert on exactly what the client sent.
// Written synchronously on every call (rather than only at exit) so a test
// can read it as soon as the corresponding client.request() resolves.
const CAPTURE_FILE = process.env.FAKE_COPILOT_CAPTURE_FILE;
const recordedCalls = [];

function recordCall(method, params) {
  recordedCalls.push({ method, params });
  if (CAPTURE_FILE) {
    fs.writeFileSync(CAPTURE_FILE, JSON.stringify(recordedCalls), "utf8");
  }
}

// Lets a scenario simulate the real CLI's server→client requests (e.g. a
// tool-call permission request under `requestPermission: true`) — the exact
// bug Task 16 found the client silently dropping. `session.send` below
// optionally sends one of these before replaying the normal event stream, so
// a test can assert the client answers it (and answers it correctly) rather
// than hanging.
let nextServerRequestId = 1;
const pendingServerRequests = new Map();

function sendServerRequest(sessionId, method, params = {}) {
  const id = `srv-${nextServerRequestId++}`;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params: { sessionId, ...params } });
  });
}

// The real Copilot CLI rejects `session.resume` for an id it has never
// created (probed live against Copilot 1.0.80: `-32603 "Session not found:
// <id>"`). Track which ids this fixture process actually knows about so a
// bug that calls session.resume for a session that was never created can't
// hide behind a fixture that accepts any id. A scenario's `sessions` list
// (already used to fake `sessions.list`) doubles as "sessions that already
// existed before this run" and seeds this set too.
const knownSessions = new Set((scenario.sessions ?? []).map((session) => session.sessionId));

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const handlers = {
  connect: () => ({ ok: true, protocolVersion: 3, version: scenario.version ?? "1.0.80" }),
  ping: () => ({ message: "pong", timestamp: "2026-01-01T00:00:00.000Z", protocolVersion: 3 }),
  "auth.getStatus": () =>
    scenario.auth ?? {
      isAuthenticated: true,
      authType: "gh-cli",
      host: "https://github.com",
      statusMessage: "fixture (via gh)",
      login: "fixture"
    },
  "models.list": () => ({ models: scenario.models ?? DEFAULT_MODELS }),
  "session.create": (params) => {
    recordCall("session.create", params);
    knownSessions.add(params.sessionId);
    return { sessionId: params.sessionId, workspacePath: `/tmp/fake/${params.sessionId}`, capabilities: {} };
  },
  "session.resume": (params) => {
    recordCall("session.resume", params);
    if (!knownSessions.has(params.sessionId)) {
      throw new RpcError(-32603, `Session not found: ${params.sessionId}`);
    }
    return { sessionId: params.sessionId, workspacePath: `/tmp/fake/${params.sessionId}`, capabilities: {} };
  },
  "session.mode.set": () => null,
  "session.name.set": () => null,
  "session.permissions.setAllowAll": () => ({ ok: true }),
  "session.metadata.snapshot": (params) => ({ sessionId: params.sessionId, currentMode: "plan" }),
  "sessions.list": () => ({ sessions: scenario.sessions ?? [] }),
  "session.interruptMainTurn": () => ({ ok: true }),
  "session.destroy": (params) => {
    // The real Copilot CLI only emits session.shutdown when the session is
    // actually torn down via session.destroy — never inline in a turn's
    // event stream. runCopilotTurn does not call session.destroy today, so
    // in practice this never fires during a normal task/review run; usage
    // observed during a turn comes from assistant.usage events instead.
    emitEvent(params.sessionId, {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      type: "session.shutdown",
      data: scenario.shutdown ?? { shutdownType: "routine", totalPremiumRequests: 1 }
    });
    return { success: true };
  },
  "session.send": (params) => {
    queueMicrotask(async () => {
      if (scenario.serverRequest) {
        const reply = await sendServerRequest(
          params.sessionId,
          scenario.serverRequest.method,
          scenario.serverRequest.params ?? {}
        );
        recordCall("__serverRequestReply", reply);
      }
      replayEvents(params.sessionId);
    });
    return { messageId: "msg-1" };
  },
  // Unimplemented unless a scenario opts in with `metrics`, matching every
  // real CLI build most of this test suite was written against before this
  // RPC's existence was confirmed live (Task 16). Answering it by default
  // for every scenario would silently change what every pre-existing
  // event-based usage test observes — session.usage.getMetrics would
  // override assistant.usage's numbers even for tests that never intended
  // to exercise it.
  "session.usage.getMetrics": (params) => {
    recordCall("session.usage.getMetrics", params);
    if (!scenario.metrics || scenario.metricsUnsupported) {
      throw new RpcError(-32601, "Unknown method: session.usage.getMetrics");
    }
    return scenario.metrics;
  }
};

function replayEvents(sessionId) {
  const events = scenario.events ?? [
    { type: "session.start", data: { sessionId } },
    { type: "assistant.turn_start", data: {} },
    { type: "assistant.message", data: { content: scenario.finalMessage ?? "fixture answer" } },
    { type: "assistant.usage", data: { premiumRequests: scenario.premiumRequests ?? 1 } },
    { type: "assistant.turn_end", data: { status: "completed" } }
  ];
  for (const event of events) {
    emitEvent(sessionId, { id: `evt-${Math.random().toString(36).slice(2)}`, ...event });
  }
}

const decode = createMessageDecoder();
process.stdin.on("data", (chunk) => {
  for (const message of decode(chunk)) {
    // A response to a request *this fixture* sent (sendServerRequest above)
    // carries an id but no method — route it to the waiting resolver rather
    // than falling into the "unknown method" branch below, which would
    // otherwise misinterpret it as a request the fixture itself must answer.
    if (message.id !== undefined && message.method === undefined && pendingServerRequests.has(message.id)) {
      const resolve = pendingServerRequests.get(message.id);
      pendingServerRequests.delete(message.id);
      resolve(message);
      continue;
    }

    if (message.id === undefined) {
      continue;
    }
    const handler = handlers[message.method];
    if (!handler) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
      continue;
    }
    try {
      send({ jsonrpc: "2.0", id: message.id, result: handler(message.params ?? {}) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: error.code ?? -32603, message: error.message ?? String(error) }
      });
    }
  }
});

process.on("SIGTERM", () => process.exit(0));
