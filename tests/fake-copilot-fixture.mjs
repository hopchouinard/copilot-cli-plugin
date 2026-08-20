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
    createdSessions.push(params);
    return { sessionId: params.sessionId, workspacePath: `/tmp/fake/${params.sessionId}`, capabilities: {} };
  },
  "session.mode.set": () => null,
  "session.name.set": () => null,
  "session.permissions.setAllowAll": () => ({ ok: true }),
  "session.metadata.snapshot": (params) => ({ sessionId: params.sessionId, currentMode: "plan" }),
  "sessions.list": () => ({ sessions: scenario.sessions ?? [] }),
  "session.interruptMainTurn": () => ({ ok: true }),
  "session.destroy": () => ({ success: true }),
  "session.send": (params) => {
    queueMicrotask(() => replayEvents(params.sessionId));
    return { messageId: "msg-1" };
  }
};

const createdSessions = [];

function replayEvents(sessionId) {
  const events = scenario.events ?? [
    { type: "session.start", data: { sessionId } },
    { type: "assistant.turn_start", data: {} },
    { type: "assistant.message", data: { content: scenario.finalMessage ?? "fixture answer" } },
    { type: "assistant.turn_end", data: { status: "completed" } },
    { type: "session.shutdown", data: { shutdownType: "routine", totalPremiumRequests: 1 } }
  ];
  for (const event of events) {
    emitEvent(sessionId, { id: `evt-${Math.random().toString(36).slice(2)}`, ...event });
  }
}

const decode = createMessageDecoder();
process.stdin.on("data", (chunk) => {
  for (const message of decode(chunk)) {
    if (message.id === undefined) {
      continue;
    }
    const handler = handlers[message.method];
    if (!handler) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
      continue;
    }
    send({ jsonrpc: "2.0", id: message.id, result: handler(message.params ?? {}) });
  }
});

// Expose what the client sent, for assertions.
process.on("SIGTERM", () => process.exit(0));
