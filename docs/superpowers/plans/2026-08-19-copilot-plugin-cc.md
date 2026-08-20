# Copilot Plugin for Claude Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that delegates code review and coding tasks to the user's local GitHub Copilot CLI, at surface parity with `openai/codex-plugin-cc`.

**Architecture:** A zero-dependency Node.js companion script talks JSON-RPC 2.0 over stdio to `copilot --headless --stdio`. Claude Code slash commands invoke that script and return its stdout verbatim. Background work is detached worker processes tracked in a workspace-scoped job store on disk.

**Tech Stack:** Node.js ESM (`.mjs`), no runtime dependencies, `node --test` with `node:assert/strict`, GitHub Copilot CLI >= 1.0.80.

**Spec:** `docs/superpowers/specs/2026-08-18-copilot-plugin-cc-design.md`

## Global Constraints

- **Zero runtime dependencies.** `package.json` has no `dependencies` block. Dev dependencies are permitted only for CI tooling. Never `npm install` a library into the plugin.
- **Node floor:** `>=18.18.0`, declared in `package.json` `engines`.
- **Copilot CLI floor:** `>=1.0.80`. The RPC handshake asserts `protocolVersion >= 3`.
- **All files are ESM.** `package.json` sets `"type": "module"`. Use `import`, never `require`.
- **Never guess Copilot tool names or model ids.** Derive them from the live runtime (`session.tools.getCurrentMetadata`, `models.list`). The model table in spec §3.10 is a measurement, not a constant to hardcode.
- **Never send an unresolved model.** Every `session.create` carries an explicitly resolved model id (spec §6.8, D8).
- **Reference repo.** Several modules are ports. Clone the reference once and refer to it by this exact path:
  ```bash
  git clone --depth 1 https://github.com/openai/codex-plugin-cc.git /tmp/codex-plugin-cc
  ```
  Reference files live under `/tmp/codex-plugin-cc/plugins/codex/`.
- **Naming:** marketplace `github-copilot`, plugin `copilot`, commands `/copilot:<name>`. In all user-facing copy the product is "Copilot", never "Codex".
- **Tests must be hermetic.** No test may invoke the real `copilot` binary or consume a premium request. Everything runs against the fake fixture from Task 1.
- **Commit after every task.** Conventional commit prefixes (`feat:`, `test:`, `chore:`).

---

# Phase 1 — Runtime foundation

Delivers a working `/copilot:setup` that proves the transport, auth probe, and model resolution end to end.

---

### Task 1: Repo scaffolding, JSON-RPC client, and the fake Copilot fixture

**Files:**
- Create: `package.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/copilot/.claude-plugin/plugin.json`
- Create: `plugins/copilot/scripts/lib/rpc-client.mjs`
- Test: `tests/fake-copilot-fixture.mjs`
- Test: `tests/rpc-client.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `encodeMessage(message: object): string`
  - `createMessageDecoder(): (chunk: Buffer) => object[]`
  - `REQUIRED_PROTOCOL_VERSION: number` (3)
  - `class CopilotRpcClient` with `static connect(cwd, options?): Promise<CopilotRpcClient>`, `request(method, params): Promise<any>`, `notify(method, params): void`, `setNotificationHandler(fn): void`, `close(): Promise<void>`, `.stderr: string`, `.serverVersion: string`
  - Fixture: `tests/fake-copilot-fixture.mjs` is an executable Node script honoring `FAKE_COPILOT_SCRIPT` (path to a JSON scenario file)

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "copilot-plugin-cc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Use GitHub Copilot from Claude Code to review code or delegate tasks.",
  "license": "MIT",
  "engines": { "node": ">=18.18.0" },
  "scripts": {
    "test": "node --test tests/*.test.mjs"
  }
}
```

- [ ] **Step 2: Create the plugin and marketplace manifests**

`plugins/copilot/.claude-plugin/plugin.json`:

```json
{
  "name": "copilot",
  "version": "0.1.0",
  "description": "Use GitHub Copilot from Claude Code to review code or delegate tasks.",
  "author": { "name": "pchouinard" }
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "github-copilot",
  "owner": { "name": "pchouinard" },
  "metadata": {
    "description": "GitHub Copilot plugin for Claude Code: delegation and code review.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "copilot",
      "description": "Use GitHub Copilot from Claude Code to review code or delegate tasks.",
      "version": "0.1.0",
      "author": { "name": "pchouinard" },
      "source": "./plugins/copilot"
    }
  ]
}
```

- [ ] **Step 3: Write the failing framing tests**

`tests/rpc-client.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeMessage, createMessageDecoder } from "../plugins/copilot/scripts/lib/rpc-client.mjs";

test("encodeMessage emits a Content-Length frame with CRLF separator", () => {
  const frame = encodeMessage({ id: 1, method: "ping" });
  const body = JSON.stringify({ id: 1, method: "ping" });
  assert.equal(frame, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
});

test("encodeMessage counts bytes, not characters", () => {
  const frame = encodeMessage({ text: "café →" });
  const declared = Number(/Content-Length: (\d+)/.exec(frame)[1]);
  const body = frame.slice(frame.indexOf("\r\n\r\n") + 4);
  assert.equal(declared, Buffer.byteLength(body, "utf8"));
  assert.notEqual(declared, body.length);
});

test("decoder returns one message per complete frame", () => {
  const decode = createMessageDecoder();
  const messages = decode(Buffer.from(encodeMessage({ id: 1, result: "a" })));
  assert.deepEqual(messages, [{ id: 1, result: "a" }]);
});

test("decoder buffers a frame split across chunks", () => {
  const decode = createMessageDecoder();
  const frame = encodeMessage({ id: 7, result: "split" });
  const cut = frame.length - 5;
  assert.deepEqual(decode(Buffer.from(frame.slice(0, cut))), []);
  assert.deepEqual(decode(Buffer.from(frame.slice(cut))), [{ id: 7, result: "split" }]);
});

test("decoder returns every message when several arrive in one chunk", () => {
  const decode = createMessageDecoder();
  const chunk = encodeMessage({ id: 1 }) + encodeMessage({ id: 2 }) + encodeMessage({ id: 3 });
  assert.deepEqual(decode(Buffer.from(chunk)), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("decoder throws on a header with no Content-Length", () => {
  const decode = createMessageDecoder();
  assert.throws(() => decode(Buffer.from("Content-Type: json\r\n\r\n{}")), /Malformed frame header/);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test tests/rpc-client.test.mjs`
Expected: FAIL — `Cannot find module '.../rpc-client.mjs'`

- [ ] **Step 5: Implement framing**

Create `plugins/copilot/scripts/lib/rpc-client.mjs`:

```js
import { spawn } from "node:child_process";
import process from "node:process";

export const REQUIRED_PROTOCOL_VERSION = 3;

const HEADER_SEPARATOR = "\r\n\r\n";
const DEFAULT_ARGS = ["--headless", "--no-auto-update", "--stdio", "--log-level", "error"];

export function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${HEADER_SEPARATOR}${body}`;
}

export function createMessageDecoder() {
  let buffer = Buffer.alloc(0);

  return function decode(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const messages = [];

    for (;;) {
      const separator = buffer.indexOf(HEADER_SEPARATOR);
      if (separator === -1) {
        break;
      }

      const header = buffer.subarray(0, separator).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error(`Malformed frame header: ${header}`);
      }

      const length = Number(match[1]);
      const start = separator + HEADER_SEPARATOR.length;
      if (buffer.length < start + length) {
        break;
      }

      messages.push(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
      buffer = buffer.subarray(start + length);
    }

    return messages;
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/rpc-client.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 7: Write the fake Copilot fixture**

`tests/fake-copilot-fixture.mjs` — an executable stub speaking the same protocol. It reads a JSON scenario from `FAKE_COPILOT_SCRIPT`:

```js
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
```

Make it executable: `chmod +x tests/fake-copilot-fixture.mjs`

- [ ] **Step 8: Write the failing client tests**

Append to `tests/rpc-client.test.mjs`:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotRpcClient } from "../plugins/copilot/scripts/lib/rpc-client.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

test("client completes the connect handshake and reports the server version", async () => {
  const client = await CopilotRpcClient.connect(process.cwd(), { binary: FIXTURE });
  assert.equal(client.serverVersion, "1.0.80");
  const pong = await client.request("ping", {});
  assert.equal(pong.message, "pong");
  await client.close();
});

test("client rejects a request whose method the server does not know", async () => {
  const client = await CopilotRpcClient.connect(process.cwd(), { binary: FIXTURE });
  await assert.rejects(() => client.request("nope.method", {}), /Unknown method/);
  await client.close();
});

test("client routes notifications to the handler", async () => {
  const client = await CopilotRpcClient.connect(process.cwd(), { binary: FIXTURE });
  const seen = [];
  client.setNotificationHandler((message) => seen.push(message.method));
  await client.request("session.create", { sessionId: "s1" });
  await client.request("session.send", { sessionId: "s1", prompt: "hi" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(seen.includes("session.event"));
  await client.close();
});
```

- [ ] **Step 9: Run to verify the new tests fail**

Run: `node --test tests/rpc-client.test.mjs`
Expected: FAIL — `CopilotRpcClient is not a constructor` / not exported

- [ ] **Step 10: Implement the client**

Append to `plugins/copilot/scripts/lib/rpc-client.mjs`:

```js
export class CopilotRpcClient {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitResolved = false;
    this.serverVersion = null;
    this.notificationHandler = null;
    this.decode = createMessageDecoder();
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  static async connect(cwd, options = {}) {
    const client = new CopilotRpcClient(cwd, options);
    await client.initialize();
    return client;
  }

  async initialize() {
    const binary = this.options.binary ?? "copilot";
    const args = this.options.args ?? DEFAULT_ARGS;

    this.proc = spawn(binary, args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => this.handleExit(error));
    this.proc.on("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.handleExit(
        code === 0 || this.closed
          ? null
          : new Error(
              `copilot exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${detail ? `\n${detail}` : ""}`
            )
      );
    });

    this.proc.stdout.on("data", (chunk) => {
      let messages;
      try {
        messages = this.decode(chunk);
      } catch (error) {
        this.handleExit(error);
        return;
      }
      for (const message of messages) {
        this.handleMessage(message);
      }
    });

    const handshake = await this.request("connect", { protocolVersion: REQUIRED_PROTOCOL_VERSION });
    if (!handshake?.ok) {
      throw new Error("Copilot CLI refused the SDK handshake.");
    }
    if (Number(handshake.protocolVersion) < REQUIRED_PROTOCOL_VERSION) {
      throw new Error(
        `Copilot CLI speaks protocol ${handshake.protocolVersion}; this plugin needs ${REQUIRED_PROTOCOL_VERSION}. Update with \`npm install -g @github/copilot\`.`
      );
    }
    this.serverVersion = handshake.version ?? null;
  }

  handleMessage(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? `${pending.method} failed.`);
        error.rpcCode = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (message.method) {
      this.notificationHandler?.(message);
    }
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }
    this.exitResolved = true;
    const failure = error ?? new Error("copilot connection closed.");
    for (const pending of this.pending.values()) {
      pending.reject(failure);
    }
    this.pending.clear();
    this.resolveExit();
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  request(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new Error("copilot rpc client is closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }
    this.closed = true;
    this.proc?.stdin.end();
    const timer = setTimeout(() => {
      if (this.proc && this.proc.exitCode === null) {
        this.proc.kill("SIGTERM");
      }
    }, 200);
    timer.unref?.();
    await this.exitPromise;
    clearTimeout(timer);
  }
}
```

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: PASS, 9 tests

- [ ] **Step 12: Commit**

```bash
git add package.json .claude-plugin plugins/copilot/.claude-plugin plugins/copilot/scripts/lib/rpc-client.mjs tests/
git commit -m "feat: JSON-RPC client for copilot --headless --stdio, with fake fixture"
```

---

### Task 2: Workspace state store

**Files:**
- Create: `plugins/copilot/scripts/lib/workspace.mjs`
- Create: `plugins/copilot/scripts/lib/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `resolveWorkspaceRoot(cwd): string`
  - `resolveStateDir(cwd): string`, `resolveJobsDir(cwd)`, `resolveJobFile(cwd, jobId)`, `resolveJobLogFile(cwd, jobId)`
  - `loadState(cwd)`, `saveState(cwd, state)`, `updateState(cwd, mutate)`
  - `getConfig(cwd): object`, `setConfig(cwd, key, value)`
  - `listJobs(cwd): object[]`, `upsertJob(cwd, patch)`, `generateJobId(prefix): string`
  - `writeJobFile(cwd, jobId, payload)`, `readJobFile(jobFile)`
  - Default config shape: `{ stopReviewGate: false, costWarnThreshold: 6, reviewModel: null, taskModel: null, effort: null, modelCatalog: null }`

- [ ] **Step 1: Port the two modules**

Copy from the reference, unchanged except the constant rename:

```bash
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/workspace.mjs plugins/copilot/scripts/lib/workspace.mjs
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/state.mjs plugins/copilot/scripts/lib/state.mjs
```

Then in `state.mjs` change `FALLBACK_STATE_ROOT_DIR` from `codex-companion` to `copilot-companion`, and replace `defaultState()` with:

```js
function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      costWarnThreshold: 6,
      reviewModel: null,
      taskModel: null,
      effort: null,
      modelCatalog: null
    },
    jobs: []
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfig, setConfig, listJobs, upsertJob, generateJobId, loadState } from "../plugins/copilot/scripts/lib/state.mjs";

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-state-"));
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return dir;
}

test("config defaults include the cost warn threshold and null model roles", () => {
  const cwd = tempWorkspace();
  const config = getConfig(cwd);
  assert.equal(config.stopReviewGate, false);
  assert.equal(config.costWarnThreshold, 6);
  assert.equal(config.reviewModel, null);
  assert.equal(config.taskModel, null);
  assert.equal(config.modelCatalog, null);
});

test("setConfig persists a value and leaves the other defaults intact", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const config = getConfig(cwd);
  assert.equal(config.reviewModel, "claude-sonnet-4.6");
  assert.equal(config.costWarnThreshold, 6);
});

test("upsertJob inserts then merges by id", () => {
  const cwd = tempWorkspace();
  const id = generateJobId("review");
  upsertJob(cwd, { id, status: "running" });
  upsertJob(cwd, { id, status: "completed", summary: "done" });
  const jobs = listJobs(cwd);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].summary, "done");
});

test("state prunes to the 50 newest jobs", () => {
  const cwd = tempWorkspace();
  for (let index = 0; index < 55; index += 1) {
    upsertJob(cwd, { id: `job-${index}`, status: "completed" });
  }
  assert.equal(loadState(cwd).jobs.length, 50);
});

test("generateJobId is prefixed and unique", () => {
  const a = generateJobId("task");
  const b = generateJobId("task");
  assert.ok(a.startsWith("task-"));
  assert.notEqual(a, b);
});
```

- [ ] **Step 3: Run to verify tests pass after the port**

Run: `node --test tests/state.test.mjs`
Expected: PASS, 5 tests. If the default-config test fails, the `defaultState()` edit in Step 1 was not applied.

- [ ] **Step 4: Commit**

```bash
git add plugins/copilot/scripts/lib/workspace.mjs plugins/copilot/scripts/lib/state.mjs tests/state.test.mjs
git commit -m "feat: port workspace-scoped state store with copilot config defaults"
```

---

### Task 3: Model roster cache, resolution chain, and effort validation

**Files:**
- Create: `plugins/copilot/scripts/lib/models.mjs`
- Test: `tests/models.test.mjs`

**Interfaces:**
- Consumes: `getConfig`, `setConfig` from `state.mjs`; `CopilotRpcClient` from `rpc-client.mjs`
- Produces:
  - `normalizeCatalog(modelsListResponse): { models: Array<{id, multiplier, reasoningEfforts, premium}>, cachedAt: string }`
  - `resolveModel({ role, flagModel, config, env, repoSettings, userSettings }): { model: string, source: string }`
  - `validateEffort(modelId, effort, catalog): string | null` — throws on unsupported
  - `multiplierFor(modelId, catalog): number | null`
  - `cheapestModel(catalog): string | null`
  - `readUserSettings(homeDir)`, `readRepoSettings(repoRoot)`
  - `CATALOG_TTL_MS: number` (7 days)

**Role values:** `"review"` reads `config.reviewModel`; `"task"` reads `config.taskModel`.
**Source values:** `"flag" | "config" | "env" | "repo-settings" | "user-settings" | "fallback"`.

- [ ] **Step 1: Write the failing resolution tests**

`tests/models.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCatalog,
  resolveModel,
  validateEffort,
  multiplierFor,
  cheapestModel
} from "../plugins/copilot/scripts/lib/models.mjs";

const RAW = {
  models: [
    { id: "auto", capabilities: {}, billing: { discountPercent: 10 } },
    {
      id: "claude-sonnet-4.6",
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "max"] } },
      billing: { multiplier: 9 }
    },
    { id: "claude-haiku-4.5", capabilities: { supports: {} }, billing: { multiplier: 0.33 } },
    {
      id: "gpt-5.3-codex",
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
      billing: { multiplier: 6 }
    }
  ]
};

const CATALOG = normalizeCatalog(RAW);

const EMPTY = { reviewModel: null, taskModel: null, effort: null };

test("normalizeCatalog extracts multiplier and effort support", () => {
  const sonnet = CATALOG.models.find((model) => model.id === "claude-sonnet-4.6");
  assert.equal(sonnet.multiplier, 9);
  assert.deepEqual(sonnet.reasoningEfforts, ["low", "medium", "high", "max"]);
  const haiku = CATALOG.models.find((model) => model.id === "claude-haiku-4.5");
  assert.deepEqual(haiku.reasoningEfforts, []);
  assert.ok(CATALOG.cachedAt);
});

test("the flag beats every other source", () => {
  const resolved = resolveModel({
    role: "review",
    flagModel: "gpt-5.3-codex",
    config: { ...EMPTY, reviewModel: "claude-haiku-4.5" },
    env: { COPILOT_MODEL: "auto" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "gpt-5.3-codex", source: "flag" });
});

test("plugin config beats env, repo settings, and user settings", () => {
  const resolved = resolveModel({
    role: "review",
    flagModel: null,
    config: { ...EMPTY, reviewModel: "claude-haiku-4.5" },
    env: { COPILOT_MODEL: "auto" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "claude-haiku-4.5", source: "config" });
});

test("role selects which config key is read", () => {
  const config = { ...EMPTY, reviewModel: "claude-sonnet-4.6", taskModel: "gpt-5.3-codex" };
  assert.equal(resolveModel({ role: "review", config, env: {} }).model, "claude-sonnet-4.6");
  assert.equal(resolveModel({ role: "task", config, env: {} }).model, "gpt-5.3-codex");
});

test("env beats repo settings and user settings", () => {
  const resolved = resolveModel({
    role: "task",
    config: EMPTY,
    env: { COPILOT_MODEL: "gpt-5.3-codex" },
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "auto" }
  });
  assert.deepEqual(resolved, { model: "gpt-5.3-codex", source: "env" });
});

test("repo settings beat user settings", () => {
  const resolved = resolveModel({
    role: "task",
    config: EMPTY,
    env: {},
    repoSettings: { model: "claude-sonnet-4.6" },
    userSettings: { model: "claude-haiku-4.5" }
  });
  assert.deepEqual(resolved, { model: "claude-sonnet-4.6", source: "repo-settings" });
});

test("user settings are read because the RPC layer ignores them", () => {
  const resolved = resolveModel({
    role: "task",
    config: EMPTY,
    env: {},
    repoSettings: null,
    userSettings: { model: "claude-haiku-4.5" }
  });
  assert.deepEqual(resolved, { model: "claude-haiku-4.5", source: "user-settings" });
});

test("falls back to auto when nothing is configured", () => {
  const resolved = resolveModel({ role: "task", config: EMPTY, env: {} });
  assert.deepEqual(resolved, { model: "auto", source: "fallback" });
});

test("validateEffort passes a supported level through", () => {
  assert.equal(validateEffort("claude-sonnet-4.6", "high", CATALOG), "high");
});

test("validateEffort rejects a level the model does not support, naming the allowed set", () => {
  assert.throws(
    () => validateEffort("claude-sonnet-4.6", "xhigh", CATALOG),
    /claude-sonnet-4\.6.*low, medium, high, max/s
  );
});

test("validateEffort returns null when no effort was requested", () => {
  assert.equal(validateEffort("claude-haiku-4.5", null, CATALOG), null);
});

test("validateEffort rejects any effort for a model that supports none", () => {
  assert.throws(() => validateEffort("claude-haiku-4.5", "low", CATALOG), /does not support reasoning effort/);
});

test("multiplierFor reads the catalog, and auto reports a discount as null", () => {
  assert.equal(multiplierFor("claude-sonnet-4.6", CATALOG), 9);
  assert.equal(multiplierFor("auto", CATALOG), null);
});

test("cheapestModel skips auto and picks the lowest multiplier", () => {
  assert.equal(cheapestModel(CATALOG), "claude-haiku-4.5");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/models.test.mjs`
Expected: FAIL — `Cannot find module '.../models.mjs'`

- [ ] **Step 3: Implement models.mjs**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_MODEL = "auto";

export function normalizeCatalog(response) {
  const models = (response?.models ?? []).map((model) => ({
    id: model.id,
    multiplier: typeof model.billing?.multiplier === "number" ? model.billing.multiplier : null,
    discountPercent:
      typeof model.billing?.discountPercent === "number" ? model.billing.discountPercent : null,
    reasoningEfforts: Array.isArray(model.capabilities?.supports?.reasoning_effort)
      ? model.capabilities.supports.reasoning_effort
      : [],
    premium: model.billing?.is_premium ?? null
  }));

  return { models, cachedAt: new Date().toISOString() };
}

export function isCatalogStale(catalog, now = Date.now()) {
  if (!catalog?.cachedAt) {
    return true;
  }
  return now - Date.parse(catalog.cachedAt) > CATALOG_TTL_MS;
}

function configKeyForRole(role) {
  return role === "review" ? "reviewModel" : "taskModel";
}

export function resolveModel({ role, flagModel, config = {}, env = {}, repoSettings, userSettings }) {
  const trimmed = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

  const candidates = [
    [trimmed(flagModel), "flag"],
    [trimmed(config[configKeyForRole(role)]), "config"],
    [trimmed(env.COPILOT_MODEL), "env"],
    [trimmed(repoSettings?.model), "repo-settings"],
    [trimmed(userSettings?.model), "user-settings"]
  ];

  for (const [model, source] of candidates) {
    if (model) {
      return { model, source };
    }
  }

  return { model: FALLBACK_MODEL, source: "fallback" };
}

function findModel(modelId, catalog) {
  return catalog?.models?.find((model) => model.id === modelId) ?? null;
}

export function validateEffort(modelId, effort, catalog) {
  if (effort == null || effort === "") {
    return null;
  }

  const normalized = String(effort).trim().toLowerCase();
  const model = findModel(modelId, catalog);
  if (!model) {
    throw new Error(`Unknown model "${modelId}". Run /copilot:setup to refresh the model list.`);
  }

  if (model.reasoningEfforts.length === 0) {
    throw new Error(
      `Model ${modelId} does not support reasoning effort. Drop --effort, or pick a model that supports it.`
    );
  }

  if (!model.reasoningEfforts.includes(normalized)) {
    throw new Error(
      `Model ${modelId} does not accept effort "${normalized}". Supported: ${model.reasoningEfforts.join(", ")}.`
    );
  }

  return normalized;
}

export function multiplierFor(modelId, catalog) {
  return findModel(modelId, catalog)?.multiplier ?? null;
}

export function cheapestModel(catalog) {
  const priced = (catalog?.models ?? []).filter((model) => typeof model.multiplier === "number");
  if (priced.length === 0) {
    return null;
  }
  return priced.reduce((lowest, model) => (model.multiplier < lowest.multiplier ? model : lowest)).id;
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readUserSettings(homeDir = os.homedir()) {
  return readJsonIfPresent(path.join(homeDir, ".copilot", "settings.json"));
}

export function readRepoSettings(repoRoot) {
  if (!repoRoot) {
    return null;
  }
  return readJsonIfPresent(path.join(repoRoot, ".github", "copilot", "settings.json"));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/models.test.mjs`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/copilot/scripts/lib/models.mjs tests/models.test.mjs
git commit -m "feat: model resolution chain, roster cache, per-model effort validation"
```

---

### Task 4: Availability, auth, and the turn primitive

**Files:**
- Create: `plugins/copilot/scripts/lib/process.mjs` (ported)
- Create: `plugins/copilot/scripts/lib/fs.mjs` (ported)
- Create: `plugins/copilot/scripts/lib/copilot.mjs`
- Test: `tests/copilot.test.mjs`

**Interfaces:**
- Consumes: `CopilotRpcClient`; `normalizeCatalog`, `validateEffort` from `models.mjs`
- Produces:
  - `getCopilotAvailability(cwd, options?): { available, detail, version }`
  - `getCopilotAuthStatus(cwd, options?): Promise<{ available, loggedIn, detail, authType, login, host }>`
  - `fetchModelCatalog(cwd, options?): Promise<catalog>`
  - `runCopilotTurn(cwd, options): Promise<TurnResult>` — options and result exactly as spec §6.2
  - `interruptCopilotTurn(cwd, { sessionId }, options?): Promise<{ attempted, interrupted, detail }>`
  - `findLatestTaskSession(cwd, options?): Promise<{ sessionId } | null>`
  - `parseStructuredOutput(rawOutput, fallback?): { parsed, parseError, rawOutput }`
  - `TASK_SESSION_PREFIX: string` (`"Copilot Companion Task"`)
  - All functions accept `options.binary` so tests point at the fixture.

- [ ] **Step 1: Port the two small helpers**

```bash
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/process.mjs plugins/copilot/scripts/lib/process.mjs
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/fs.mjs plugins/copilot/scripts/lib/fs.mjs
```

No edits needed. They provide `binaryAvailable`, `runCommand`, `runCommandChecked`, `formatCommandFailure`, `terminateProcessTree`, `readJsonFile`, `isProbablyText`, `readStdinIfPiped`.

- [ ] **Step 2: Write the failing turn-capture tests**

`tests/copilot.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCopilotTurn, parseStructuredOutput, getCopilotAuthStatus } from "../plugins/copilot/scripts/lib/copilot.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function scenarioFile(scenario) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scn-")), "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario), "utf8");
  return file;
}

function withScenario(scenario) {
  return { binary: FIXTURE, env: { ...process.env, FAKE_COPILOT_SCRIPT: scenarioFile(scenario) } };
}

test("auth status reports the fixture login", async () => {
  const status = await getCopilotAuthStatus(process.cwd(), withScenario({}));
  assert.equal(status.loggedIn, true);
  assert.equal(status.login, "fixture");
});

test("a completed turn returns the final assistant message and exit status 0", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "review this",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({ finalMessage: "no findings" })
  });
  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "no findings");
  assert.ok(result.sessionId);
});

test("progress events map onto phases in order", async () => {
  const phases = [];
  await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    onProgress: (event) => {
      const phase = typeof event === "object" ? event.phase : null;
      if (phase) phases.push(phase);
    },
    ...withScenario({
      events: [
        { type: "session.start", data: {} },
        { type: "assistant.turn_start", data: {} },
        { type: "command.execute", data: { command: "npm test" } },
        { type: "assistant.message", data: { content: "done" } },
        { type: "assistant.turn_end", data: { status: "completed" } }
      ]
    })
  });
  assert.ok(phases.includes("starting"));
  assert.ok(phases.includes("verifying"), "npm test should be classified as verification");
  assert.ok(phases.includes("finalizing"));
});

test("a turn that ends without turn_end still resolves via the inferred timer", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({
      events: [
        { type: "assistant.turn_start", data: {} },
        { type: "assistant.message", data: { content: "partial" } }
      ]
    })
  });
  assert.equal(result.finalMessage, "partial");
});

test("read-only turns exclude write tools and set plan mode", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({})
  });
  assert.equal(result.mode, "plan");
});

test("parseStructuredOutput strips a fenced code block before parsing", () => {
  const parsed = parseStructuredOutput('```json\n{"verdict":"approve"}\n```');
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput reports a parse error without throwing", () => {
  const parsed = parseStructuredOutput("not json at all");
  assert.equal(parsed.parsed, null);
  assert.ok(parsed.parseError);
  assert.equal(parsed.rawOutput, "not json at all");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/copilot.test.mjs`
Expected: FAIL — `Cannot find module '.../copilot.mjs'`

- [ ] **Step 4: Implement copilot.mjs**

```js
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
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test tests/copilot.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add plugins/copilot/scripts/lib/process.mjs plugins/copilot/scripts/lib/fs.mjs plugins/copilot/scripts/lib/copilot.mjs tests/copilot.test.mjs
git commit -m "feat: availability, auth, and turn capture against the Copilot RPC runtime"
```

---

### Task 5: Usage accounting and cost prediction

**Files:**
- Create: `plugins/copilot/scripts/lib/usage.mjs`
- Test: `tests/usage.test.mjs`

**Interfaces:**
- Consumes: `multiplierFor`, `cheapestModel` from `models.mjs`
- Produces:
  - `describeCost(modelId, catalog): { model, multiplier, label }` — `label` is e.g. `"claude-sonnet-4.6 (9x premium)"`, or `"auto (10% discount)"`, or `"claude-x (cost unknown)"`
  - `exceedsThreshold(modelId, catalog, threshold): boolean` — false when threshold is 0
  - `formatUsage(usage): string | null` — null when there is nothing to report
  - `summariseJobUsage(jobs): { premiumRequests: number, jobs: number } | null`

- [ ] **Step 1: Write the failing tests**

`tests/usage.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCatalog } from "../plugins/copilot/scripts/lib/models.mjs";
import { describeCost, exceedsThreshold, formatUsage, summariseJobUsage } from "../plugins/copilot/scripts/lib/usage.mjs";

const CATALOG = normalizeCatalog({
  models: [
    { id: "auto", capabilities: {}, billing: { discountPercent: 10 } },
    { id: "claude-sonnet-4.6", capabilities: {}, billing: { multiplier: 9 } },
    { id: "claude-haiku-4.5", capabilities: {}, billing: { multiplier: 0.33 } }
  ]
});

test("describeCost labels a priced model with its multiplier", () => {
  assert.equal(describeCost("claude-sonnet-4.6", CATALOG).label, "claude-sonnet-4.6 (9x premium)");
});

test("describeCost labels auto with its discount", () => {
  assert.equal(describeCost("auto", CATALOG).label, "auto (10% discount)");
});

test("describeCost says the cost is unknown for a model missing from the catalog", () => {
  assert.equal(describeCost("mystery-model", CATALOG).label, "mystery-model (cost unknown)");
});

test("exceedsThreshold is true at exactly the threshold", () => {
  assert.equal(exceedsThreshold("claude-sonnet-4.6", CATALOG, 9), true);
});

test("exceedsThreshold is false below the threshold", () => {
  assert.equal(exceedsThreshold("claude-haiku-4.5", CATALOG, 6), false);
});

test("a threshold of 0 disables the check entirely", () => {
  assert.equal(exceedsThreshold("claude-sonnet-4.6", CATALOG, 0), false);
});

test("an uncatalogued model never trips the threshold", () => {
  assert.equal(exceedsThreshold("mystery-model", CATALOG, 6), false);
});

test("formatUsage returns null when nothing was reported", () => {
  assert.equal(formatUsage({ premiumRequests: null, aiu: null }), null);
});

test("formatUsage reports premium requests when present", () => {
  assert.match(formatUsage({ premiumRequests: 3, model: "claude-sonnet-4.6" }), /3 premium request/);
});

test("summariseJobUsage totals only jobs that reported usage", () => {
  const summary = summariseJobUsage([
    { usage: { premiumRequests: 2 } },
    { usage: { premiumRequests: 1 } },
    { usage: null },
    {}
  ]);
  assert.deepEqual(summary, { premiumRequests: 3, jobs: 2 });
});

test("summariseJobUsage returns null when no job reported usage", () => {
  assert.equal(summariseJobUsage([{ usage: null }, {}]), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/usage.test.mjs`
Expected: FAIL — `Cannot find module '.../usage.mjs'`

- [ ] **Step 3: Implement usage.mjs**

```js
import { multiplierFor } from "./models.mjs";

function catalogEntry(modelId, catalog) {
  return catalog?.models?.find((model) => model.id === modelId) ?? null;
}

export function describeCost(modelId, catalog) {
  const entry = catalogEntry(modelId, catalog);
  const multiplier = multiplierFor(modelId, catalog);

  if (typeof multiplier === "number") {
    return { model: modelId, multiplier, label: `${modelId} (${multiplier}x premium)` };
  }

  if (typeof entry?.discountPercent === "number") {
    return { model: modelId, multiplier: null, label: `${modelId} (${entry.discountPercent}% discount)` };
  }

  return { model: modelId, multiplier: null, label: `${modelId} (cost unknown)` };
}

export function exceedsThreshold(modelId, catalog, threshold) {
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit <= 0) {
    return false;
  }
  const multiplier = multiplierFor(modelId, catalog);
  if (typeof multiplier !== "number") {
    return false;
  }
  return multiplier >= limit;
}

export function formatUsage(usage) {
  if (!usage || typeof usage.premiumRequests !== "number") {
    return null;
  }
  const plural = usage.premiumRequests === 1 ? "" : "s";
  const model = usage.model ? ` on ${usage.model}` : "";
  return `${usage.premiumRequests} premium request${plural}${model}`;
}

export function summariseJobUsage(jobs) {
  const reporting = (jobs ?? []).filter((job) => typeof job?.usage?.premiumRequests === "number");
  if (reporting.length === 0) {
    return null;
  }
  return {
    premiumRequests: reporting.reduce((total, job) => total + job.usage.premiumRequests, 0),
    jobs: reporting.length
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/usage.test.mjs`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/copilot/scripts/lib/usage.mjs tests/usage.test.mjs
git commit -m "feat: premium-request accounting and pre-run cost prediction"
```

---

### Task 6: Companion CLI dispatcher and the `/copilot:setup` command

**Files:**
- Create: `plugins/copilot/scripts/lib/args.mjs` (ported)
- Create: `plugins/copilot/scripts/lib/render.mjs`
- Create: `plugins/copilot/scripts/copilot-companion.mjs`
- Create: `plugins/copilot/commands/setup.md`
- Test: `tests/setup.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–5
- Produces:
  - `copilot-companion.mjs setup [--json] [--model <id>] [--review-model <id>] [--task-model <id>] [--effort <level>] [--cost-warn-threshold <n>] [--enable-review-gate|--disable-review-gate]`
  - `renderSetupReport(report): string`
  - `buildSetupReport(cwd, options): Promise<report>` exported from the companion for tests

- [ ] **Step 1: Port the argument parser**

```bash
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/args.mjs plugins/copilot/scripts/lib/args.mjs
```

It exports `parseArgs(argv, { valueOptions, booleanOptions, aliasMap })` returning `{ options, positionals }`, and `splitRawArgumentString(raw)`. No edits needed.

- [ ] **Step 2: Write the failing setup tests**

`tests/setup.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSetupReport } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { renderSetupReport } from "../plugins/copilot/scripts/lib/render.mjs";
import { getConfig, setConfig } from "../plugins/copilot/scripts/lib/state.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

test("setup reports auth and caches the model catalog", async () => {
  const cwd = tempWorkspace();
  const report = await buildSetupReport(cwd, { binary: FIXTURE });
  assert.equal(report.auth.loggedIn, true);
  assert.ok(report.modelCatalog.models.length > 0);
  assert.ok(getConfig(cwd).modelCatalog, "catalog should be persisted to config");
});

test("setup resolves both roles and reports the source of each", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const report = await buildSetupReport(cwd, { binary: FIXTURE });
  assert.equal(report.resolved.review.model, "claude-sonnet-4.6");
  assert.equal(report.resolved.review.source, "config");
  assert.equal(report.resolved.task.source, "fallback");
});

test("rendered setup output names the multiplier for each role", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const rendered = renderSetupReport(await buildSetupReport(cwd, { binary: FIXTURE }));
  assert.match(rendered, /review\s+claude-sonnet-4\.6\s+9x/);
  assert.match(rendered, /warn\s+at 6x/);
});

test("setup rejects an effort the chosen model does not support", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  await assert.rejects(
    () => buildSetupReport(cwd, { binary: FIXTURE, effort: "high" }),
    /does not support reasoning effort/
  );
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/setup.test.mjs`
Expected: FAIL — `Cannot find module '.../copilot-companion.mjs'`

- [ ] **Step 4: Implement the renderer**

Create `plugins/copilot/scripts/lib/render.mjs` with the setup renderer. Later tasks append to this file.

```js
import { describeCost, formatUsage } from "./usage.mjs";

function line(label, value) {
  return `${label.padEnd(8)}${value}`;
}

export function renderSetupReport(report) {
  const lines = [];

  lines.push(report.ready ? "Copilot is ready." : "Copilot is not ready yet.");
  lines.push("");
  lines.push(line("node", report.node.detail));
  lines.push(line("copilot", report.copilot.detail));
  lines.push(line("auth", report.auth.detail));
  lines.push("");

  for (const role of ["review", "task"]) {
    const resolved = report.resolved[role];
    const cost = describeCost(resolved.model, report.modelCatalog);
    const multiplier = typeof cost.multiplier === "number" ? `${cost.multiplier}x` : "-";
    lines.push(`${role.padEnd(8)}${resolved.model.padEnd(24)}${multiplier.padEnd(8)}from ${resolved.source}`);
  }

  lines.push(line("effort", report.resolved.effort ?? "(model default)"));
  lines.push(line("warn", report.costWarnThreshold > 0 ? `at ${report.costWarnThreshold}x` : "disabled"));
  lines.push(line("gate", report.reviewGateEnabled ? "enabled" : "disabled"));

  if (report.actionsTaken.length > 0) {
    lines.push("");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export { formatUsage };
```

- [ ] **Step 5: Implement the companion dispatcher with the setup subcommand**

Create `plugins/copilot/scripts/copilot-companion.mjs`:

```js
#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { getCopilotAvailability, getCopilotAuthStatus, fetchModelCatalog } from "./lib/copilot.mjs";
import { resolveModel, validateEffort, readUserSettings, readRepoSettings, isCatalogStale } from "./lib/models.mjs";
import { getConfig, setConfig } from "./lib/state.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { renderSetupReport } from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function normalizeArgv(argv) {
  if (argv.length === 1) {
    return argv[0]?.trim() ? splitRawArgumentString(argv[0]) : [];
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), { ...config, aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) } });
}

export async function buildSetupReport(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];

  for (const [flag, key] of [
    ["model", null],
    ["review-model", "reviewModel"],
    ["task-model", "taskModel"]
  ]) {
    const value = options[flag];
    if (!value) {
      continue;
    }
    if (flag === "model") {
      setConfig(workspaceRoot, "reviewModel", value);
      setConfig(workspaceRoot, "taskModel", value);
      actionsTaken.push(`Set both review and task models to ${value}.`);
    } else {
      setConfig(workspaceRoot, key, value);
      actionsTaken.push(`Set ${key} to ${value}.`);
    }
  }

  if (options["cost-warn-threshold"] !== undefined) {
    setConfig(workspaceRoot, "costWarnThreshold", Number(options["cost-warn-threshold"]));
    actionsTaken.push(`Set the cost warning threshold to ${options["cost-warn-threshold"]}x.`);
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push("Enabled the stop-time review gate.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push("Disabled the stop-time review gate.");
  }

  const node = binaryAvailable("node", ["--version"], { cwd });
  const npm = binaryAvailable("npm", ["--version"], { cwd });
  const copilot = getCopilotAvailability(cwd, options);
  const auth = copilot.available
    ? await getCopilotAuthStatus(cwd, options)
    : { available: false, loggedIn: false, detail: copilot.detail, authType: null, login: null, host: null };

  let config = getConfig(workspaceRoot);
  let modelCatalog = config.modelCatalog;

  if (copilot.available && (isCatalogStale(modelCatalog) || options.refreshCatalog)) {
    modelCatalog = await fetchModelCatalog(cwd, options);
    setConfig(workspaceRoot, "modelCatalog", modelCatalog);
    config = getConfig(workspaceRoot);
  }

  if (options.effort !== undefined) {
    const probe = resolveModel({ role: "task", config, env: process.env });
    validateEffort(probe.model, options.effort, modelCatalog);
    setConfig(workspaceRoot, "effort", options.effort);
    actionsTaken.push(`Set the default reasoning effort to ${options.effort}.`);
    config = getConfig(workspaceRoot);
  }

  const userSettings = readUserSettings();
  const repoSettings = readRepoSettings(workspaceRoot);
  const resolved = {
    review: resolveModel({ role: "review", config, env: process.env, repoSettings, userSettings }),
    task: resolveModel({ role: "task", config, env: process.env, repoSettings, userSettings }),
    effort: config.effort
  };

  const nextSteps = [];
  if (!copilot.available) {
    nextSteps.push("Install Copilot CLI with `npm install -g @github/copilot`.");
  } else if (!auth.loggedIn) {
    nextSteps.push("Run `!copilot login`.");
  }
  if (!config.reviewModel && !config.taskModel) {
    nextSteps.push("Pick models with `/copilot:setup --model <id>` so runs have a predictable cost.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: `/copilot:setup --enable-review-gate`. Each firing costs a premium request.");
  }

  return {
    ready: node.available && copilot.available && auth.loggedIn,
    node,
    npm,
    copilot,
    auth,
    modelCatalog,
    resolved,
    costWarnThreshold: config.costWarnThreshold,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "model", "review-model", "task-model", "effort", "cost-warn-threshold"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const report = await buildSetupReport(cwd, options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSetupReport(report));
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand ?? "(none)"}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Run to verify the tests pass**

Run: `node --test tests/setup.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 7: Write the setup command file**

`plugins/copilot/commands/setup.md`:

```markdown
---
description: Check whether the local Copilot CLI is ready, choose models, and manage the review gate
argument-hint: '[--model <id>] [--review-model <id>] [--task-model <id>] [--effort <level>] [--cost-warn-threshold <n>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If the result says Copilot is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Copilot now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Copilot CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run `npm install -g @github/copilot`, then rerun the setup command above.

If the user passed `--model` with no value:
- Read `modelCatalog.models` from the JSON result.
- Use `AskUserQuestion` exactly once to let them pick a model.
- Label each option with the model id, and put its multiplier and supported effort levels in the description, for example `9x premium · low, medium, high, max`.
- Order the options cheapest first.
- Then rerun the setup command with `--model <chosen id>`.

Output rules:
- Present the final setup output to the user.
- If Copilot is installed but not authenticated, preserve the guidance to run `!copilot login`.
- Preserve the resolved model table exactly as returned, including the multiplier column and the source of each value.
```

- [ ] **Step 8: Verify the command runs against the real CLI**

Run: `node plugins/copilot/scripts/copilot-companion.mjs setup`
Expected: a report naming your real Copilot version, your login, and a resolved model for both roles. This is the Phase 1 acceptance check and consumes no premium requests.

- [ ] **Step 9: Commit**

```bash
git add plugins/copilot/scripts plugins/copilot/commands/setup.md tests/setup.test.mjs
git commit -m "feat: companion CLI dispatcher and /copilot:setup with model management"
```

---

# Phase 2 — Review

---

### Task 7: Git review context

**Files:**
- Create: `plugins/copilot/scripts/lib/git.mjs` (ported verbatim)
- Test: `tests/git.test.mjs` (ported)

**Interfaces:**
- Consumes: `process.mjs`, `fs.mjs`
- Produces: `ensureGitRepository(cwd)`, `getRepoRoot(cwd)`, `detectDefaultBranch(cwd)`, `getCurrentBranch(cwd)`, `getWorkingTreeState(cwd)`, `resolveReviewTarget(cwd, { base, scope }): { mode, label, baseRef?, explicit }`, `collectReviewContext(cwd, target, options?): { repoRoot, branch, target, content, summary, changedFiles, fileCount, diffBytes, inputMode, collectionGuidance }`

- [ ] **Step 1: Port the module and its tests**

```bash
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/git.mjs plugins/copilot/scripts/lib/git.mjs
cp /tmp/codex-plugin-cc/tests/git.test.mjs tests/git.test.mjs
cp /tmp/codex-plugin-cc/tests/helpers.mjs tests/helpers.mjs
```

`git.mjs` is harness-agnostic and needs no edits. In `tests/git.test.mjs` and `tests/helpers.mjs`, fix the import paths from `plugins/codex/` to `plugins/copilot/`.

- [ ] **Step 2: Run the ported tests**

Run: `node --test tests/git.test.mjs`
Expected: PASS. If any test references `codex`, the import-path fix in Step 1 was incomplete.

- [ ] **Step 3: Commit**

```bash
git add plugins/copilot/scripts/lib/git.mjs tests/git.test.mjs tests/helpers.mjs
git commit -m "feat: port git review-context collection"
```

---

### Task 8: Review schema, prompts, and the review engine

**Files:**
- Create: `plugins/copilot/schemas/review-output.schema.json`
- Create: `plugins/copilot/prompts/review.md`
- Create: `plugins/copilot/prompts/adversarial-review.md`
- Create: `plugins/copilot/scripts/lib/prompts.mjs` (ported)
- Modify: `plugins/copilot/scripts/lib/render.mjs` (add `renderReviewResult`)
- Modify: `plugins/copilot/scripts/copilot-companion.mjs` (add `review` and `adversarial-review`)
- Create: `plugins/copilot/commands/review.md`
- Create: `plugins/copilot/commands/adversarial-review.md`
- Test: `tests/review.test.mjs`

**Interfaces:**
- Consumes: `collectReviewContext`, `resolveReviewTarget`, `runCopilotTurn`, `parseStructuredOutput`, `resolveModel`, `validateEffort`, `describeCost`
- Produces:
  - `buildReviewPrompt(context, { template, focusText, schema }): string`
  - `renderReviewResult(parsed, { reviewLabel, targetLabel, costLabel, usage }): string`
  - Companion subcommands `review` and `adversarial-review`

- [ ] **Step 1: Copy the schema and prompt helper**

```bash
cp /tmp/codex-plugin-cc/plugins/codex/schemas/review-output.schema.json plugins/copilot/schemas/review-output.schema.json
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/prompts.mjs plugins/copilot/scripts/lib/prompts.mjs
```

The schema is used verbatim. `prompts.mjs` exports `loadPromptTemplate(rootDir, name)` and `interpolateTemplate(template, values)`.

- [ ] **Step 2: Write the adversarial prompt template**

`plugins/copilot/prompts/adversarial-review.md` — copy the reference template and change only the role line and the output contract:

```bash
cp /tmp/codex-plugin-cc/plugins/codex/prompts/adversarial-review.md plugins/copilot/prompts/adversarial-review.md
```

Then change the `<role>` block to:

```
<role>
You are GitHub Copilot performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>
```

And replace the `<structured_output_contract>` block with one that carries the schema inline, because this harness cannot enforce a schema:

```
<structured_output_contract>
Return ONLY a single JSON object. No prose before it, no prose after it.
Do not wrap it in a Markdown code fence.
It must match this JSON Schema exactly:

{{OUTPUT_SCHEMA}}

Use `needs-attention` if there is any material risk worth blocking on.
Use `approve` only if you cannot support any substantive adversarial finding.
Every finding must include the affected file, `line_start`, `line_end`, a
confidence score from 0 to 1, and a concrete recommendation.
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>
```

- [ ] **Step 3: Write the standards-and-defects prompt template**

`plugins/copilot/prompts/review.md` — new authorship, since the reference plugin delegated to Codex's built-in reviewer:

```
<role>
You are GitHub Copilot performing a code review of a specific change.
</role>

<task>
Review the repository context below for defects that should be fixed before this
change ships.
Target: {{TARGET_LABEL}}
</task>

<review_method>
Read the change carefully and trace what it actually does, not what it appears
to intend. Prioritise, in order:
- correctness defects: wrong logic, off-by-one, inverted conditions, bad operator precedence
- contract violations: a caller or callee whose expectations this change breaks
- error handling: unhandled failures, swallowed errors, missing cleanup on the error path
- resource and lifecycle bugs: leaks, unclosed handles, unawaited promises, races
- test coverage: behaviour this change introduces or alters that no test exercises
{{REVIEW_COLLECTION_GUIDANCE}}
</review_method>

<finding_bar>
Report only material findings.
Do not report style, naming, formatting, or preference. Do not report a concern
you cannot tie to a specific line.
A finding should answer:
1. What is wrong?
2. Where exactly?
3. What breaks as a result?
4. What concrete change fixes it?
</finding_bar>

<grounding_rules>
Every finding must be defensible from the provided repository context.
Do not invent files, lines, code paths, or runtime behaviour you cannot support.
If a conclusion depends on an inference, say so in the finding body and keep the
confidence honest.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
If the change looks correct, say so directly and return no findings.
</calibration_rules>

<structured_output_contract>
Return ONLY a single JSON object. No prose before it, no prose after it.
Do not wrap it in a Markdown code fence.
It must match this JSON Schema exactly:

{{OUTPUT_SCHEMA}}

Use `needs-attention` when any finding should block the change.
Use `approve` when you found nothing material.
</structured_output_contract>

<repository_context>
{{REVIEW_INPUT}}
</repository_context>
```

- [ ] **Step 4: Write the failing review tests**

`tests/review.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReviewPrompt } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { renderReviewResult } from "../plugins/copilot/scripts/lib/render.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "copilot");

const CONTEXT = {
  target: { label: "working tree diff" },
  collectionGuidance: "Use the repository context below as primary evidence.",
  content: "## Git Status\n\nM src/a.js\n"
};

test("the review prompt inlines the JSON schema, because the harness cannot enforce one", () => {
  const prompt = buildReviewPrompt(ROOT, CONTEXT, { template: "review", focusText: "" });
  assert.match(prompt, /"verdict"/);
  assert.match(prompt, /needs-attention/);
  assert.ok(!prompt.includes("{{OUTPUT_SCHEMA}}"), "the placeholder must be interpolated");
});

test("the review prompt carries the target label and repository context", () => {
  const prompt = buildReviewPrompt(ROOT, CONTEXT, { template: "review", focusText: "" });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /M src\/a\.js/);
});

test("the adversarial prompt carries the user focus text", () => {
  const prompt = buildReviewPrompt(ROOT, CONTEXT, {
    template: "adversarial-review",
    focusText: "question the retry design"
  });
  assert.match(prompt, /question the retry design/);
});

test("renderReviewResult lists findings ordered by severity with file and line", () => {
  const rendered = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "One blocking issue.",
        findings: [
          { severity: "low", title: "Nit", body: "b", file: "b.js", line_start: 2, line_end: 2, confidence: 0.4, recommendation: "r" },
          { severity: "critical", title: "Data loss", body: "b", file: "a.js", line_start: 10, line_end: 12, confidence: 0.9, recommendation: "r" }
        ],
        next_steps: ["Fix a.js"]
      },
      parseError: null,
      rawOutput: "{}"
    },
    { reviewLabel: "Review", targetLabel: "working tree diff", costLabel: "claude-haiku-4.5 (0.33x premium)" }
  );
  assert.ok(rendered.indexOf("Data loss") < rendered.indexOf("Nit"), "critical must sort above low");
  assert.match(rendered, /a\.js:10/);
  assert.match(rendered, /claude-haiku-4\.5/);
});

test("renderReviewResult falls back to raw output when parsing failed", () => {
  const rendered = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "Copilot said something unstructured" },
    { reviewLabel: "Review", targetLabel: "working tree diff", costLabel: "auto (10% discount)" }
  );
  assert.match(rendered, /Unexpected token/);
  assert.match(rendered, /Copilot said something unstructured/);
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `node --test tests/review.test.mjs`
Expected: FAIL — `buildReviewPrompt is not exported`

- [ ] **Step 6: Add the review renderer**

Append to `plugins/copilot/scripts/lib/render.mjs`:

```js
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export function renderReviewResult(parsed, options = {}) {
  const lines = [`# ${options.reviewLabel} — ${options.targetLabel}`, ""];

  if (options.costLabel) {
    lines.push(`model  ${options.costLabel}`);
  }
  const usageLine = formatUsage(options.usage);
  if (usageLine) {
    lines.push(`usage  ${usageLine}`);
  }
  if (options.costLabel || usageLine) {
    lines.push("");
  }

  if (!parsed.parsed) {
    lines.push("Copilot did not return parseable JSON.");
    lines.push("");
    lines.push(`Parse error: ${parsed.parseError}`);
    lines.push("");
    lines.push("Raw output:");
    lines.push("");
    lines.push(parsed.rawOutput);
    return `${lines.join("\n")}\n`;
  }

  const result = parsed.parsed;
  lines.push(`Verdict: ${result.verdict}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");

  const findings = [...(result.findings ?? [])].sort(
    (left, right) => (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
  );

  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of findings) {
      lines.push(`## [${finding.severity}] ${finding.title}`);
      lines.push(`${finding.file}:${finding.line_start}-${finding.line_end} (confidence ${finding.confidence})`);
      lines.push("");
      lines.push(finding.body);
      lines.push("");
      lines.push(`Recommendation: ${finding.recommendation}`);
      lines.push("");
    }
  }

  if ((result.next_steps ?? []).length > 0) {
    lines.push("## Next steps");
    for (const step of result.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 7: Add the review engine to the companion**

Add to `plugins/copilot/scripts/copilot-companion.mjs`:

```js
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { runCopilotTurn, parseStructuredOutput, buildTaskSessionName } from "./lib/copilot.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { renderReviewResult } from "./lib/render.mjs";
import { describeCost } from "./lib/usage.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function buildReviewPrompt(rootDir, context, { template, focusText }) {
  const schema = fs.readFileSync(path.join(rootDir, "schemas", "review-output.schema.json"), "utf8");
  return interpolateTemplate(loadPromptTemplate(rootDir, template), {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    OUTPUT_SCHEMA: schema
  });
}

async function executeReview(cwd, options, { reviewLabel, template }) {
  ensureGitRepository(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const catalog = config.modelCatalog;

  const { model } = resolveModel({
    role: "review",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });
  const effort = validateEffort(model, options.effort ?? config.effort, catalog);

  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target);
  const prompt = buildReviewPrompt(ROOT_DIR, context, {
    template,
    focusText: options.focusText ?? ""
  });

  const result = await runCopilotTurn(context.repoRoot, {
    prompt,
    model,
    effort,
    readOnly: true,
    sessionName: `${reviewLabel}: ${target.label}`,
    onProgress: options.onProgress,
    binary: options.binary,
    env: options.env
  });

  const parsed = parseStructuredOutput(result.finalMessage, {
    failureMessage: result.error?.message ?? result.stderr
  });

  return {
    exitStatus: result.status,
    sessionId: result.sessionId,
    payload: { review: reviewLabel, target, model, effort, result: parsed.parsed, rawOutput: parsed.rawOutput, parseError: parsed.parseError, usage: result.usage },
    rendered: renderReviewResult(parsed, {
      reviewLabel,
      targetLabel: target.label,
      costLabel: describeCost(model, catalog).label,
      usage: result.usage
    }),
    usage: result.usage
  };
}
```

Wire two new cases into `main()`:

```js
    case "review":
      await handleReview(argv, { reviewLabel: "Review", template: "review", allowFocus: false });
      break;
    case "adversarial-review":
      await handleReview(argv, { reviewLabel: "Adversarial Review", template: "adversarial-review", allowFocus: true });
      break;
```

And the handler:

```js
async function handleReview(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const focusText = positionals.join(" ").trim();

  if (focusText && !config.allowFocus) {
    throw new Error(
      `\`/copilot:review\` does not take focus text. Use \`/copilot:adversarial-review ${focusText}\` instead.`
    );
  }

  const execution = await executeReview(cwd, { ...options, focusText }, config);
  process.stdout.write(options.json ? `${JSON.stringify(execution.payload, null, 2)}\n` : execution.rendered);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}
```

- [ ] **Step 8: Run to verify the tests pass**

Run: `node --test tests/review.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 9: Write the two review command files**

`plugins/copilot/commands/review.md`:

```markdown
---
description: Run a Copilot code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--effort <level>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Copilot review through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Copilot's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- `/copilot:review` does not support focus text. If the user wants to steer the review, tell them to use `/copilot:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch with `Bash(..., run_in_background: true)` using the same command.
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Copilot review started in the background. Check `/copilot:status` for progress."
```

`plugins/copilot/commands/adversarial-review.md` is the same file with these differences: the description reads "Run a Copilot review that challenges the implementation approach and design choices"; the argument hint ends with `[focus ...]`; the subcommand is `adversarial-review`; the focus-text prohibition is replaced with "Do not weaken the adversarial framing or rewrite the user's focus text."; and this paragraph is added after the core constraint:

```
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions. It is not just a stricter pass over implementation defects. Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.
```

- [ ] **Step 10: Commit**

```bash
git add plugins/copilot/schemas plugins/copilot/prompts plugins/copilot/scripts plugins/copilot/commands tests/review.test.mjs
git commit -m "feat: review engine, prompt templates, and the two review commands"
```

---

# Phase 3 — Delegation

---

### Task 9: Task runs, the rescue subagent, and the internal skills

**Files:**
- Modify: `plugins/copilot/scripts/copilot-companion.mjs` (add `task`, `task-resume-candidate`)
- Create: `plugins/copilot/commands/rescue.md`
- Create: `plugins/copilot/agents/copilot-rescue.md`
- Create: `plugins/copilot/skills/copilot-cli-runtime/SKILL.md`
- Create: `plugins/copilot/skills/copilot-result-handling/SKILL.md`
- Create: `plugins/copilot/skills/copilot-prompting/SKILL.md`
- Test: `tests/task.test.mjs`

**Interfaces:**
- Consumes: `runCopilotTurn`, `findLatestTaskSession`, `buildTaskSessionName`, `resolveModel` with `role: "task"`
- Produces: companion subcommands `task [--write] [--resume-last] [--model <id>] [--effort <level>] [prompt]` and `task-resume-candidate --json`

- [ ] **Step 1: Write the failing task tests**

`tests/task.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeTask } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { setConfig } from "../plugins/copilot/scripts/lib/state.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

test("a task run resolves the task model, not the review model", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  setConfig(cwd, "taskModel", "gpt-5.3-codex");
  const execution = await executeTask(cwd, { prompt: "fix the bug", binary: FIXTURE });
  assert.equal(execution.payload.model, "gpt-5.3-codex");
});

test("a write-capable task runs in interactive mode, not plan mode", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, { prompt: "fix it", write: true, binary: FIXTURE });
  assert.equal(execution.payload.mode, "interactive");
});

test("a read-only task runs in plan mode", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, { prompt: "investigate", write: false, binary: FIXTURE });
  assert.equal(execution.payload.mode, "plan");
});

test("a task with neither a prompt nor --resume-last is rejected", async () => {
  const cwd = tempWorkspace();
  await assert.rejects(() => executeTask(cwd, { prompt: "", binary: FIXTURE }), /Provide a prompt/);
});

test("the task payload carries usage so status can total it later", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, { prompt: "go", binary: FIXTURE });
  assert.equal(execution.payload.usage.premiumRequests, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/task.test.mjs`
Expected: FAIL — `executeTask is not exported`

- [ ] **Step 3: Implement executeTask in the companion**

```js
export async function executeTask(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const catalog = config.modelCatalog;

  const { model } = resolveModel({
    role: "task",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });
  const effort = validateEffort(model, options.effort ?? config.effort, catalog);

  let sessionId = null;
  if (options.resumeLast) {
    const latest = await findLatestTaskSession(workspaceRoot, options);
    if (!latest) {
      throw new Error("No previous Copilot task session was found for this repository.");
    }
    sessionId = latest.sessionId;
  }

  if (!options.prompt && !sessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runCopilotTurn(workspaceRoot, {
    sessionId,
    prompt: options.prompt,
    defaultPrompt: sessionId ? DEFAULT_CONTINUE_PROMPT : "",
    model,
    effort,
    readOnly: !options.write,
    sessionName: sessionId ? null : buildTaskSessionName(options.prompt),
    onProgress: options.onProgress,
    binary: options.binary,
    env: options.env
  });

  return {
    exitStatus: result.status,
    sessionId: result.sessionId,
    payload: {
      model,
      effort,
      mode: result.mode,
      sessionId: result.sessionId,
      rawOutput: result.finalMessage,
      touchedFiles: result.touchedFiles,
      usage: result.usage
    },
    rendered: renderTaskResult(result, { model, catalog, write: Boolean(options.write) }),
    usage: result.usage
  };
}
```

Add `renderTaskResult` to `render.mjs`:

```js
export function renderTaskResult(result, options = {}) {
  const lines = [`# Copilot Task`, ""];
  lines.push(`model  ${describeCost(options.model, options.catalog).label}`);
  const usageLine = formatUsage(result.usage);
  if (usageLine) {
    lines.push(`usage  ${usageLine}`);
  }
  lines.push("");
  lines.push(result.finalMessage || "(no output)");
  if (options.write && result.touchedFiles.length > 0) {
    lines.push("");
    lines.push("Copilot edited these files:");
    for (const file of result.touchedFiles) {
      lines.push(`- ${file}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
```

Wire `task` and `task-resume-candidate` cases into `main()` following the same handler shape as `handleReview`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/task.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the rescue subagent**

`plugins/copilot/agents/copilot-rescue.md`:

```markdown
---
name: copilot-rescue
description: Proactively use when Claude Code is stuck, wants a second implementation or diagnosis pass, needs a deeper root-cause investigation, or should hand a substantial coding task to GitHub Copilot through the shared runtime
model: sonnet
tools: Bash
skills:
  - copilot-cli-runtime
  - copilot-prompting
---

You are a thin forwarding wrapper around the Copilot companion task runtime.

Your only job is to forward the user's rescue request to the Copilot companion script. Do not do anything else.

Selection guidance:

- Do not wait for the user to explicitly ask for Copilot. Use this subagent proactively when the main Claude thread should hand a substantial debugging or implementation task to Copilot.
- Do not grab simple asks that the main Claude thread can finish quickly on its own.

Forwarding rules:

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task ...`.
- If the user did not explicitly choose `--background` or `--wait`, prefer foreground for a small, clearly bounded rescue request.
- If the task looks complicated, open-ended, multi-step, or likely to run long, prefer background execution.
- You may use the `copilot-prompting` skill only to tighten the user's request into a better Copilot prompt before forwarding it.
- Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work beyond shaping the forwarded prompt text.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`. This subagent only forwards to `task`.
- Leave `--model` and `--effort` unset unless the user explicitly asked for a specific model or effort. The plugin resolves both from its own configuration.
- Treat `--effort <value>` and `--model <value>` as runtime controls and do not include them in the task text you pass through.
- Default to a write-capable Copilot run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- Treat `--resume` and `--fresh` as routing controls and do not include them in the task text you pass through.
- `--resume` means add `--resume-last`. `--fresh` means do not add `--resume-last`.
- If the user is clearly asking to continue prior Copilot work, such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", add `--resume-last` unless `--fresh` is present.
- Preserve the user's task text as-is apart from stripping routing flags.
- Return the stdout of the `copilot-companion` command exactly as-is.
- If the Bash call fails or Copilot cannot be invoked, return nothing.

Response style:

- Do not add commentary before or after the forwarded `copilot-companion` output.
```

- [ ] **Step 6: Write the three internal skills**

`plugins/copilot/skills/copilot-cli-runtime/SKILL.md`:

```markdown
---
name: copilot-cli-runtime
description: Internal helper contract for calling the copilot-companion runtime from Claude Code
user-invocable: false
---

# Copilot Runtime

Use this skill only inside the `copilot:copilot-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Copilot CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `copilot:copilot-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `copilot-prompting` skill to rewrite the user's request into a tighter Copilot prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`.
- If the forwarded request includes `--model` or `--effort`, pass them through to `task`.
- If the forwarded request includes `--resume`, strip that token and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token and do not add `--resume-last`.

Model and effort:
- Leave `--model` and `--effort` unset unless the user explicitly asked. The plugin resolves both from its own configuration, and an unset flag is the correct default.
- Never invent a model id. Valid ids come from `/copilot:setup`.
- Effort levels are per-model. If the user asks for an effort the model does not support, the helper returns an error naming the supported set. Return that error as-is; do not retry with a different value.

Safety rules:
- Default to write-capable Copilot work unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Copilot cannot be invoked, return nothing.
```

`plugins/copilot/skills/copilot-result-handling/SKILL.md`:

```markdown
---
name: copilot-result-handling
description: Internal guidance for presenting Copilot helper output back to the user
user-invocable: false
---

# Copilot Result Handling

When the helper returns Copilot output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve the model and usage lines. They tell the user what the run cost.
- Preserve evidence boundaries. If Copilot marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Copilot made edits, say so explicitly and list the touched files when the helper provides them.
- For `copilot:copilot-rescue`, do not turn a failed or incomplete Copilot run into a Claude-side implementation attempt. Report the failure and stop.
- For `copilot:copilot-rescue`, if Copilot was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Copilot run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/copilot:setup` and do not improvise alternate auth flows.
```

`plugins/copilot/skills/copilot-prompting/SKILL.md`:

```markdown
---
name: copilot-prompting
description: Internal guidance for composing Copilot prompts for coding, review, diagnosis, and research tasks inside the Copilot Claude Code plugin
user-invocable: false
---

# Copilot Prompting

Use this skill when `copilot:copilot-rescue` needs to ask Copilot for help.

Prompt Copilot like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- Prefer one clear task per Copilot run. Split unrelated asks into separate runs.
- Tell Copilot what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning effort or adding long explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Copilot should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Copilot stays narrow and avoids unrelated refactors.

## Stating a JSON contract without a schema parameter

Copilot CLI has no output-schema parameter. When a run must return JSON, the
contract lives entirely in the prompt and must be stated defensively:

- Say "Return ONLY a single JSON object" explicitly.
- Say "No prose before it, no prose after it."
- Say "Do not wrap it in a Markdown code fence." Models add fences by default.
- Inline the full JSON Schema in the prompt rather than describing it.
- Name the enum values inline for any constrained field.

The plugin's parser strips a fence if one appears anyway, but a prompt that
prevents the fence is better than a parser that repairs it.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Do not raise reasoning effort first. Tighten the prompt and verification rules before escalating.
- Reasoning effort is per-model and some models support none at all. Never assume an effort level is available.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.
```

- [ ] **Step 7: Write the rescue command**

`plugins/copilot/commands/rescue.md`:

```markdown
---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Copilot rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <id>] [--effort <level>] [what Copilot should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `copilot:copilot-rescue` subagent via the `Agent` tool (`subagent_type: "copilot:copilot-rescue"`), forwarding the raw user request as the prompt.
`copilot:copilot-rescue` is a subagent, not a skill — do not call `Skill(copilot:copilot-rescue)` or `Skill(copilot:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be Copilot's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the task text.
- If the request includes `--resume` or `--fresh`, do not ask. The user already chose.
- Otherwise, before starting Copilot, check for a resumable session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Copilot session or start a new one.
- The two choices must be:
  - `Continue current Copilot session`
  - `Start a new Copilot session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Copilot session (Recommended)` first.
- Otherwise put `Start a new Copilot session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Copilot companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/copilot:status`, fetch `/copilot:result`, call `/copilot:cancel`, summarize output, or do follow-up work of its own.
- Leave `--model` and `--effort` unset unless the user explicitly asks. The plugin resolves both.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Copilot is missing or unauthenticated, stop and tell the user to run `/copilot:setup`.
- If the user did not supply a request, ask what Copilot should investigate or fix.
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, all tests green

- [ ] **Step 9: Commit**

```bash
git add plugins/copilot tests/task.test.mjs
git commit -m "feat: task runs, rescue subagent, and the three internal skills"
```

---

# Phase 4 — Jobs, hooks, and transfer

---

### Task 10: Job tracking and background execution

**Files:**
- Create: `plugins/copilot/scripts/lib/tracked-jobs.mjs` (ported, extended)
- Create: `plugins/copilot/scripts/lib/job-control.mjs` (ported, renamed field)
- Modify: `plugins/copilot/scripts/copilot-companion.mjs` (background path, `task-worker`)
- Test: `tests/jobs.test.mjs`

**Interfaces:**
- Consumes: `state.mjs`
- Produces:
  - `runTrackedJob(job, runner, { logFile }): Promise<execution>` — writes `usage` into the job record
  - `createJobRecord`, `createJobLogFile`, `createProgressReporter`, `createJobProgressUpdater`, `appendLogLine`, `appendLogBlock`, `nowIso`, `SESSION_ID_ENV`
  - `buildStatusSnapshot(cwd, { all })`, `buildSingleJobSnapshot(cwd, reference)`, `resolveResultJob`, `resolveCancelableJob`, `readStoredJob`, `sortJobsNewestFirst`
  - `SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID"`

- [ ] **Step 1: Port both modules**

```bash
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/tracked-jobs.mjs plugins/copilot/scripts/lib/tracked-jobs.mjs
cp /tmp/codex-plugin-cc/plugins/codex/scripts/lib/job-control.mjs plugins/copilot/scripts/lib/job-control.mjs
```

Apply these edits:

1. In `tracked-jobs.mjs`, change `SESSION_ID_ENV` from `"CODEX_COMPANION_SESSION_ID"` to `"COPILOT_COMPANION_SESSION_ID"`.
2. In `tracked-jobs.mjs`, inside `runTrackedJob`'s success path, add `usage: execution.usage ?? null` to both the `writeJobFile` payload and the `upsertJob` patch.
3. In `job-control.mjs`, rename every `threadId` reference to `sessionId`.

- [ ] **Step 2: Write the failing job tests**

`tests/jobs.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTrackedJob, createJobRecord } from "../plugins/copilot/scripts/lib/tracked-jobs.mjs";
import { buildStatusSnapshot } from "../plugins/copilot/scripts/lib/job-control.mjs";
import { generateJobId } from "../plugins/copilot/scripts/lib/state.mjs";

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

function job(workspaceRoot) {
  return createJobRecord({
    id: generateJobId("task"),
    kind: "task",
    kindLabel: "rescue",
    title: "Copilot Task",
    workspaceRoot,
    jobClass: "task",
    summary: "test job"
  });
}

test("a successful tracked job records usage on the job", async () => {
  const cwd = tempWorkspace();
  const record = job(cwd);
  await runTrackedJob(record, async () => ({
    exitStatus: 0,
    payload: {},
    rendered: "done",
    summary: "done",
    usage: { premiumRequests: 4, model: "claude-sonnet-4.6" }
  }));
  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.jobs[0].usage.premiumRequests, 4);
});

test("a failing tracked job is marked failed and rethrows", async () => {
  const cwd = tempWorkspace();
  const record = job(cwd);
  await assert.rejects(() =>
    runTrackedJob(record, async () => {
      throw new Error("copilot exploded");
    })
  );
  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.jobs[0].status, "failed");
  assert.match(snapshot.jobs[0].errorMessage, /copilot exploded/);
});

test("the status snapshot totals premium requests across jobs", async () => {
  const cwd = tempWorkspace();
  for (const premium of [1, 2]) {
    await runTrackedJob(job(cwd), async () => ({
      exitStatus: 0,
      payload: {},
      rendered: "ok",
      summary: "ok",
      usage: { premiumRequests: premium }
    }));
  }
  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.usageTotal.premiumRequests, 3);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/jobs.test.mjs`
Expected: FAIL — usage is undefined, and `usageTotal` is not on the snapshot

- [ ] **Step 4: Apply the usage edits**

Apply edits 1–3 from Step 1 if not already done, then add `usageTotal` to `buildStatusSnapshot` in `job-control.mjs`:

```js
import { summariseJobUsage } from "./usage.mjs";

// inside buildStatusSnapshot, before returning:
//   usageTotal: summariseJobUsage(jobs)
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test tests/jobs.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 6: Add the background path and worker to the companion**

```js
function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}
```

The queued job record must carry `sessionId: randomUUID()` before the worker spawns, and `executeTask` must accept and use that pre-minted id, so `/copilot:cancel` can interrupt a job whose worker has not yet reported (spec §6.6).

Add the `task-worker` case, which reads the stored job, rehydrates `request`, and runs it under `runTrackedJob`.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS

```bash
git add plugins/copilot/scripts tests/jobs.test.mjs
git commit -m "feat: job tracking, usage totals, and detached background workers"
```

---

### Task 11: Cost guard on background launches

**Files:**
- Modify: `plugins/copilot/scripts/copilot-companion.mjs` (add `cost-check` subcommand)
- Modify: `plugins/copilot/commands/review.md`, `adversarial-review.md`, `rescue.md`
- Test: `tests/cost-guard.test.mjs`

**Interfaces:**
- Consumes: `describeCost`, `exceedsThreshold`, `cheapestModel`
- Produces: `copilot-companion.mjs cost-check --role <review|task> [--model <id>] --json` returning `{ model, label, multiplier, threshold, exceeds, cheapest, cheapestLabel }`

- [ ] **Step 1: Write the failing test**

`tests/cost-guard.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCostCheck } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { setConfig } from "../plugins/copilot/scripts/lib/state.mjs";
import { normalizeCatalog } from "../plugins/copilot/scripts/lib/models.mjs";

const CATALOG = normalizeCatalog({
  models: [
    { id: "claude-sonnet-4.6", capabilities: {}, billing: { multiplier: 9 } },
    { id: "claude-haiku-4.5", capabilities: {}, billing: { multiplier: 0.33 } }
  ]
});

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
  setConfig(cwd, "modelCatalog", CATALOG);
  return cwd;
}

test("a 9x model trips the default 6x threshold and offers the cheapest alternative", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const check = buildCostCheck(cwd, { role: "review" });
  assert.equal(check.exceeds, true);
  assert.equal(check.multiplier, 9);
  assert.equal(check.cheapest, "claude-haiku-4.5");
});

test("a cheap model does not trip the threshold", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  assert.equal(buildCostCheck(cwd, { role: "review" }).exceeds, false);
});

test("a zero threshold disables the guard", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  setConfig(cwd, "costWarnThreshold", 0);
  assert.equal(buildCostCheck(cwd, { role: "review" }).exceeds, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/cost-guard.test.mjs`
Expected: FAIL — `buildCostCheck is not exported`

- [ ] **Step 3: Implement buildCostCheck**

```js
export function buildCostCheck(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const catalog = config.modelCatalog;

  const { model, source } = resolveModel({
    role: options.role === "review" ? "review" : "task",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });

  const cost = describeCost(model, catalog);
  const cheapest = cheapestModel(catalog);

  return {
    model,
    source,
    label: cost.label,
    multiplier: cost.multiplier,
    threshold: config.costWarnThreshold,
    exceeds: exceedsThreshold(model, catalog, config.costWarnThreshold),
    cheapest,
    cheapestLabel: cheapest ? describeCost(cheapest, catalog).label : null
  };
}
```

Wire a `cost-check` case into `main()` that prints the JSON.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/cost-guard.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Add the guard step to the three launching commands**

Insert this block into `review.md`, `adversarial-review.md`, and `rescue.md`, immediately before their background flow:

```markdown
Cost guard (background runs only):
- Before launching in the background, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" cost-check --role review --json
```

(use `--role task` in `/copilot:rescue`).
- Always state the returned `label` to the user on the launch line, for example `model  claude-sonnet-4.6 (9x premium)`.
- If `exceeds` is false, launch without asking.
- If `exceeds` is true, use `AskUserQuestion` exactly once with three options in this order:
  - `Run in background` — describe it as "proceed at <label>"
  - `Switch to <cheapest>` — describe it as "rerun at <cheapestLabel>"
  - `Cancel`
- If the user picks the cheaper model, append `--model <cheapest>` to the companion command.
- If the user cancels, do not launch anything and say so.
- Foreground runs never ask. State the cost and run.
```

- [ ] **Step 6: Commit**

```bash
git add plugins/copilot tests/cost-guard.test.mjs
git commit -m "feat: cost guard that confirms expensive background launches"
```

---

### Task 12: Status, result, and cancel commands

**Files:**
- Modify: `plugins/copilot/scripts/copilot-companion.mjs`
- Modify: `plugins/copilot/scripts/lib/render.mjs`
- Create: `plugins/copilot/commands/status.md`, `result.md`, `cancel.md`
- Test: `tests/status.test.mjs`

**Interfaces:**
- Consumes: `buildStatusSnapshot`, `buildSingleJobSnapshot`, `resolveResultJob`, `resolveCancelableJob`, `interruptCopilotTurn`, `terminateProcessTree`
- Produces: `renderStatusReport(report)`, `renderJobStatusReport(job)`, `renderStoredJobResult(job, storedJob)`, `renderCancelReport(job)`; companion subcommands `status`, `result`, `cancel`

- [ ] **Step 1: Write the failing status render test**

`tests/status.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStatusReport } from "../plugins/copilot/scripts/lib/render.mjs";

test("the status table includes a premium column and a session total", () => {
  const rendered = renderStatusReport({
    jobs: [
      { id: "task-1", kindLabel: "rescue", status: "completed", phase: "done", summary: "fix bug", usage: { premiumRequests: 4 } },
      { id: "review-1", kindLabel: "review", status: "running", phase: "investigating", summary: "review", usage: null }
    ],
    usageTotal: { premiumRequests: 4, jobs: 1 }
  });
  assert.match(rendered, /premium/i);
  assert.match(rendered, /task-1/);
  assert.match(rendered, /4/);
  assert.match(rendered, /session total/i);
});

test("a job with no usage renders a dash rather than a zero", () => {
  const rendered = renderStatusReport({
    jobs: [{ id: "review-1", kindLabel: "review", status: "running", phase: "starting", summary: "r", usage: null }],
    usageTotal: null
  });
  assert.doesNotMatch(rendered, /\|\s*0\s*\|/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/status.test.mjs`
Expected: FAIL — `renderStatusReport is not exported`

- [ ] **Step 3: Implement the status renderers**

Append to `render.mjs`:

```js
export function renderStatusReport(report) {
  const rows = [
    "| job | kind | status | phase | premium | summary |",
    "| --- | --- | --- | --- | --- | --- |"
  ];

  for (const job of report.jobs ?? []) {
    const premium = typeof job.usage?.premiumRequests === "number" ? String(job.usage.premiumRequests) : "-";
    rows.push(
      `| ${job.id} | ${job.kindLabel ?? job.kind ?? "-"} | ${job.status} | ${job.phase ?? "-"} | ${premium} | ${job.summary ?? "-"} |`
    );
  }

  if ((report.jobs ?? []).length === 0) {
    rows.push("| - | - | - | - | - | no jobs for this session |");
  }

  const lines = [rows.join("\n")];
  if (report.usageTotal) {
    lines.push("");
    lines.push(
      `Session total: ${report.usageTotal.premiumRequests} premium request${report.usageTotal.premiumRequests === 1 ? "" : "s"} across ${report.usageTotal.jobs} job${report.usageTotal.jobs === 1 ? "" : "s"}.`
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [`# ${job.title ?? job.id}`, ""];
  lines.push(`id      ${job.id}`);
  lines.push(`status  ${job.status}`);
  lines.push(`phase   ${job.phase ?? "-"}`);
  if (job.sessionId) {
    lines.push(`session ${job.sessionId}`);
  }
  const usageLine = formatUsage(job.usage);
  if (usageLine) {
    lines.push(`usage   ${usageLine}`);
  }
  if (job.errorMessage) {
    lines.push("");
    lines.push(`Error: ${job.errorMessage}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  if (!storedJob?.rendered) {
    return renderJobStatusReport(job);
  }
  const usageLine = formatUsage(storedJob.usage ?? job.usage);
  const suffix = usageLine ? `\nusage  ${usageLine}\n` : "";
  const resume = job.sessionId ? `\nResume in Copilot: copilot --resume=${job.sessionId}\n` : "";
  return `${storedJob.rendered}${suffix}${resume}`;
}

export function renderCancelReport(job) {
  return `Cancelled ${job.id} (${job.title ?? job.kind ?? "job"}).\n`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/status.test.mjs`
Expected: PASS, 2 tests

- [ ] **Step 5: Wire the three subcommands**

`status`, `result`, and `cancel` follow the reference plugin's handler shapes. `cancel` must call `interruptCopilotTurn(cwd, { sessionId })` before `terminateProcessTree(job.pid)`, then mark the job cancelled.

- [ ] **Step 6: Write the three command files**

`plugins/copilot/commands/status.md`:

```markdown
---
description: Show active and recent Copilot jobs for this repository, including premium-request usage
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the premium column and the session total line exactly as returned.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
```

`plugins/copilot/commands/result.md`:

```markdown
---
description: Show the stored final output for a finished Copilot job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, and next steps
- File paths and line numbers exactly as reported
- The model and usage lines
- The `copilot --resume=<session-id>` command when present
- Any error messages or parse errors
```

`plugins/copilot/commands/cancel.md`:

```markdown
---
description: Cancel an active background Copilot job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" cancel "$ARGUMENTS"`
```

- [ ] **Step 7: Commit**

```bash
git add plugins/copilot tests/status.test.mjs
git commit -m "feat: status, result, and cancel commands with usage reporting"
```

---

### Task 13: Lifecycle hooks and the stop-time review gate

**Files:**
- Create: `plugins/copilot/hooks/hooks.json`
- Create: `plugins/copilot/scripts/session-lifecycle-hook.mjs`
- Create: `plugins/copilot/scripts/stop-review-gate-hook.mjs`
- Create: `plugins/copilot/prompts/stop-review-gate.md`
- Test: `tests/hooks.test.mjs`

**Interfaces:**
- Consumes: `state.mjs`, `job-control.mjs`, `copilot.mjs`, `prompts.mjs`
- Produces: hook scripts reading a JSON hook payload on stdin; the gate emits `{ decision: "block", reason }` on stdout to block, or exits silently to allow

- [ ] **Step 1: Write the gate prompt**

`plugins/copilot/prompts/stop-review-gate.md` — port the reference template with the Codex references removed:

```
<task>
Run a stop-gate review of the previous Claude turn.
Only review the work from the previous Claude turn.
Only review it if Claude actually did code changes in that turn.
Pure status, setup, or reporting output does not count as reviewable work.
For example, the output of /copilot:setup or /copilot:status does not count.
Only direct edits made in that specific turn count.
If the previous Claude turn was only a status update, a summary, a setup/login check, a review result, or output from a command that did not itself make direct edits in that turn, return ALLOW immediately and do no further work.
Challenge whether that specific work and its design choices should ship.

{{CLAUDE_RESPONSE_BLOCK}}
</task>

<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
</compact_output_contract>

<default_follow_through_policy>
Use ALLOW if the previous turn did not make code changes or if you do not see a blocking issue.
Use ALLOW immediately, without extra investigation, if the previous turn was not an edit-producing turn.
Use BLOCK only if the previous turn made code changes and you found something that still needs to be fixed before stopping.
</default_follow_through_policy>

<grounding_rules>
Ground every blocking claim in the repository context or tool outputs you inspected during this run.
Do not treat the previous Claude response as proof that code changes happened; verify that from the repository state before you block.
Do not block based on older edits from earlier turns when the immediately previous turn did not itself make direct edits.
</grounding_rules>

<dig_deeper_nudge>
If the previous turn did make code changes, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs before you finalize.
</dig_deeper_nudge>
```

- [ ] **Step 2: Write the failing gate-parsing tests**

`tests/hooks.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStopReviewOutput } from "../plugins/copilot/scripts/stop-review-gate-hook.mjs";

test("an ALLOW first line permits the stop", () => {
  assert.deepEqual(parseStopReviewOutput("ALLOW: nothing to review"), { ok: true, reason: null });
});

test("a BLOCK first line blocks and carries the reason", () => {
  const result = parseStopReviewOutput("BLOCK: the retry loop never terminates\nmore detail");
  assert.equal(result.ok, false);
  assert.match(result.reason, /retry loop never terminates/);
});

test("empty output blocks rather than silently allowing", () => {
  assert.equal(parseStopReviewOutput("").ok, false);
});

test("an unrecognised first line blocks rather than guessing", () => {
  const result = parseStopReviewOutput("Sure! Here is my review of the changes.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected answer/i);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/hooks.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 4: Implement both hook scripts**

Port `session-lifecycle-hook.mjs` from the reference, deleting every broker import and the whole broker teardown path. It keeps only:
- `SessionStart`: append `COPILOT_COMPANION_SESSION_ID`, `CLAUDE_TRANSCRIPT_PATH`, and `CLAUDE_PLUGIN_DATA` to `$CLAUDE_ENV_FILE`
- `SessionEnd`: terminate process trees for jobs still `queued` or `running` under this session id, then drop them from state

Port `stop-review-gate-hook.mjs` from the reference, exporting `parseStopReviewOutput` for the tests, invoking `copilot-companion.mjs task --json`, and adding the premium-request note to its log line.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test tests/hooks.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 6: Write hooks.json**

```json
{
  "description": "Session lifecycle and the optional stop-time review gate for the Copilot plugin.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart", "timeout": 5 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"", "timeout": 900 }
        ]
      }
    ]
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add plugins/copilot/hooks plugins/copilot/scripts plugins/copilot/prompts/stop-review-gate.md tests/hooks.test.mjs
git commit -m "feat: session lifecycle hooks and the optional stop-time review gate"
```

---

### Task 14: Session transfer

**Files:**
- Create: `plugins/copilot/scripts/lib/claude-session-transfer.mjs`
- Modify: `plugins/copilot/scripts/copilot-companion.mjs` (add `transfer`)
- Create: `plugins/copilot/commands/transfer.md`
- Test: `tests/transfer.test.mjs`

**Interfaces:**
- Consumes: `runCopilotTurn`, `resolveModel`
- Produces:
  - `resolveClaudeSessionPath(cwd, { source }): string` — rejects a path outside `~/.claude/projects`
  - `buildTranscriptDigest(jsonlPath): { goal, decisions, filesTouched, commands, openThreads, markdown }`
  - companion subcommand `transfer [--source <path>] [--json]`

- [ ] **Step 1: Write the failing digest tests**

`tests/transfer.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTranscriptDigest, resolveClaudeSessionPath } from "../plugins/copilot/scripts/lib/claude-session-transfer.mjs";

function transcript(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tx-")), "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

test("the digest captures the first user message as the goal", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "Add retry logic to the uploader" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Sure." }] } }
  ]);
  assert.match(buildTranscriptDigest(file).goal, /retry logic to the uploader/);
});

test("the digest lists files touched by edit tool calls", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "go" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/upload.js" } }]
      }
    }
  ]);
  assert.deepEqual(buildTranscriptDigest(file).filesTouched, ["/repo/src/upload.js"]);
});

test("the digest markdown states plainly that it is a primer, not replayed history", () => {
  const file = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
  assert.match(buildTranscriptDigest(file).markdown, /primer/i);
});

test("a source outside ~/.claude/projects is rejected", () => {
  assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: "/etc/passwd" }), /~\/\.claude\/projects/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/transfer.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the transfer module**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TRANSCRIPT_PATH_ENV = "CLAUDE_TRANSCRIPT_PATH";

export function resolveClaudeSessionPath(cwd, options = {}) {
  const source = options.source ?? process.env[TRANSCRIPT_PATH_ENV];
  if (!source) {
    throw new Error(
      "No Claude transcript found. Pass --source <path>, or start a new Claude session so the SessionStart hook can record it."
    );
  }

  const resolved = path.resolve(cwd, source);
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  if (!resolved.startsWith(`${projectsRoot}${path.sep}`)) {
    throw new Error(`The transfer source must live under ~/.claude/projects. Got: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Transcript not found: ${resolved}`);
  }
  return resolved;
}

function readEntries(jsonlPath) {
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export function buildTranscriptDigest(jsonlPath) {
  const entries = readEntries(jsonlPath);
  const userMessages = entries.filter((entry) => entry.type === "user").map((entry) => textOf(entry.message?.content));
  const assistantMessages = entries
    .filter((entry) => entry.type === "assistant")
    .map((entry) => textOf(entry.message?.content))
    .filter(Boolean);

  const filesTouched = [];
  const commands = [];

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block.type !== "tool_use") {
        continue;
      }
      if (EDIT_TOOLS.has(block.name) && block.input?.file_path && !filesTouched.includes(block.input.file_path)) {
        filesTouched.push(block.input.file_path);
      }
      if (block.name === "Bash" && block.input?.command) {
        commands.push(block.input.command);
      }
    }
  }

  const goal = userMessages.find(Boolean) ?? "(no user message found)";
  const decisions = assistantMessages.slice(-5);
  const openThreads = userMessages.slice(-1);

  const markdown = [
    "# Transferred Claude Code session",
    "",
    "This is a **primer**, not replayed turn history. GitHub Copilot CLI has no",
    "session-import API, so the Claude conversation below has been condensed into",
    "a briefing. Treat it as context, not as your own prior output.",
    "",
    "## Original goal",
    "",
    goal,
    "",
    "## Files touched",
    "",
    filesTouched.length > 0 ? filesTouched.map((file) => `- ${file}`).join("\n") : "(none recorded)",
    "",
    "## Commands run",
    "",
    commands.length > 0 ? commands.slice(-10).map((command) => `- \`${command}\``).join("\n") : "(none recorded)",
    "",
    "## Where the conversation left off",
    "",
    decisions.length > 0 ? decisions.join("\n\n") : "(no assistant output recorded)",
    "",
    "## Most recent instruction",
    "",
    openThreads.join("\n") || "(none)",
    ""
  ].join("\n");

  return { goal, decisions, filesTouched, commands, openThreads, markdown };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/transfer.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Add the transfer subcommand and command file**

The subcommand resolves the transcript, builds the digest, mints a UUID, calls `runCopilotTurn` with `readOnly: true` and the digest as the prompt plus an instruction to acknowledge and wait, then prints the resume command.

`plugins/copilot/commands/transfer.md`:

```markdown
---
description: Transfer the current Claude Code session into a resumable Copilot session
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Copilot session ID and the `copilot --resume=<session-id>` command.

Preserve the note explaining that this is a primer rather than replayed turn history. Copilot CLI has no session-import API, so the transfer condenses the Claude conversation into a briefing. Do not describe it to the user as a full history transfer.
```

- [ ] **Step 6: Commit**

```bash
git add plugins/copilot tests/transfer.test.mjs
git commit -m "feat: digest-priming session transfer into Copilot"
```

---

# Phase 5 — Ship

---

### Task 15: CI, version consistency, and documentation

**Files:**
- Create: `scripts/bump-version.mjs`
- Create: `.github/workflows/pull-request-ci.yml`
- Create: `README.md`, `LICENSE`, `NOTICE`
- Create: `plugins/copilot/CHANGELOG.md`, `plugins/copilot/LICENSE`, `plugins/copilot/NOTICE`
- Test: `tests/bump-version.test.mjs`

**Interfaces:**
- Produces: `npm run check-version` exits non-zero when `package.json`, `plugin.json`, and `marketplace.json` disagree

- [ ] **Step 1: Write the failing version-consistency test**

`tests/bump-version.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectVersions, versionsAgree } from "../scripts/bump-version.mjs";

test("versions agree when all three manifests match", () => {
  assert.equal(versionsAgree({ package: "1.2.3", plugin: "1.2.3", marketplace: "1.2.3", marketplaceEntry: "1.2.3" }), true);
});

test("versions disagree when one manifest drifts", () => {
  assert.equal(versionsAgree({ package: "1.2.3", plugin: "1.2.4", marketplace: "1.2.3", marketplaceEntry: "1.2.3" }), false);
});

test("collectVersions reads all three manifests from the repo root", () => {
  const versions = collectVersions(process.cwd());
  assert.ok(versions.package);
  assert.ok(versions.plugin);
  assert.ok(versions.marketplace);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/bump-version.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bump-version.mjs**

```js
#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function collectVersions(root) {
  const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
  return {
    package: readJson(path.join(root, "package.json")).version,
    plugin: readJson(path.join(root, "plugins", "copilot", ".claude-plugin", "plugin.json")).version,
    marketplace: marketplace.metadata.version,
    marketplaceEntry: marketplace.plugins[0].version
  };
}

export function versionsAgree(versions) {
  return new Set(Object.values(versions)).size === 1;
}

export function writeVersion(root, version) {
  const packagePath = path.join(root, "package.json");
  const pluginPath = path.join(root, "plugins", "copilot", ".claude-plugin", "plugin.json");
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");

  const packageJson = readJson(packagePath);
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const pluginJson = readJson(pluginPath);
  pluginJson.version = version;
  fs.writeFileSync(pluginPath, `${JSON.stringify(pluginJson, null, 2)}\n`);

  const marketplaceJson = readJson(marketplacePath);
  marketplaceJson.metadata.version = version;
  marketplaceJson.plugins[0].version = version;
  fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplaceJson, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  if (process.argv.includes("--check")) {
    const versions = collectVersions(root);
    if (!versionsAgree(versions)) {
      process.stderr.write(`Version mismatch: ${JSON.stringify(versions)}\n`);
      process.exit(1);
    }
    process.stdout.write(`Versions agree at ${versions.package}.\n`);
  } else {
    const version = process.argv[2];
    if (!version) {
      process.stderr.write("Usage: node scripts/bump-version.mjs <version> | --check\n");
      process.exit(1);
    }
    writeVersion(root, version);
    process.stdout.write(`Set all manifests to ${version}.\n`);
  }
}
```

Add to `package.json` scripts: `"check-version": "node scripts/bump-version.mjs --check"`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/bump-version.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Add CI**

`.github/workflows/pull-request-ci.yml`:

```yaml
name: pull-request-ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm run check-version
      - run: npm test
```

- [ ] **Step 6: Write the README**

`README.md` must cover: what the plugin is; requirements (Copilot CLI >= 1.0.80, Node >= 18.18, a Copilot subscription); install via `/plugin marketplace add`; every command with examples; and three sections the reference README has no equivalent for:

1. **Choosing models** — the resolution chain from spec §6.8, and `/copilot:setup --model`.
2. **What runs cost** — that every run consumes premium requests, that multipliers vary by up to 56x across the roster, and how the cost guard and `/copilot:status` premium column work.
3. **Transfer is a primer** — that `/copilot:transfer` condenses rather than replays, because Copilot has no session-import API.

The review-gate section must carry the warning that each firing is a billable premium request at the resolved task model's multiplier.

- [ ] **Step 7: Add licence files**

MIT `LICENSE` at the repo root and duplicated at `plugins/copilot/LICENSE`. `NOTICE` in both places crediting `openai/codex-plugin-cc` (Apache-2.0) as the design this plugin is ported from. Seed `plugins/copilot/CHANGELOG.md` with a `0.1.0` entry.

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run check-version`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add scripts .github README.md LICENSE NOTICE plugins/copilot/CHANGELOG.md plugins/copilot/LICENSE plugins/copilot/NOTICE tests/bump-version.test.mjs package.json
git commit -m "chore: CI, version consistency check, and documentation"
```

---

### Task 16: End-to-end acceptance against the real Copilot CLI

**Files:**
- Modify: none expected; fix whatever this surfaces

This is the only task that spends premium requests. Budget roughly 6 runs. Run it on a scratch repository with a small, deliberate change, not on real work.

- [ ] **Step 1: Install the plugin locally**

```bash
/plugin marketplace add /Volumes/NVMe_2TB_Work/Development/copilot-cli-plugin
/plugin install copilot@github-copilot
/reload-plugins
```

- [ ] **Step 2: Verify setup reports a real runtime**

Run `/copilot:setup`.
Expected: your real Copilot version, your GitHub login, a resolved model per role with a multiplier, and the warn threshold. Consumes no premium requests.

- [ ] **Step 3: Point both roles at the cheapest model for acceptance**

Run `/copilot:setup --model claude-haiku-4.5`.
Expected: both roles report `claude-haiku-4.5` at `0.33x`, sourced from config. This keeps the rest of this task cheap.

- [ ] **Step 4: Foreground review on a tiny real diff**

Make a one-line change in a scratch repo, then run `/copilot:review --wait`.
Expected: a model line naming the multiplier, a verdict, and either findings with real file:line references or an explicit "no findings". If the output is raw JSON or a parse error, the prompt contract in Task 8 needs tightening — that is the failure this task exists to catch.

- [ ] **Step 5: Background review, status, result**

Run `/copilot:review --background`, then `/copilot:status`, then `/copilot:result`.
Expected: the status table shows the job with a premium count once it completes, and the session total line appears. `result` reprints the review plus the resume command.

- [ ] **Step 6: Verify the cost guard fires**

Run `/copilot:setup --review-model claude-sonnet-4.6`, then `/copilot:review --background`.
Expected: an `AskUserQuestion` offering proceed / switch to the cheapest model / cancel, because 9x meets the 6x threshold. Choose cancel; nothing should launch.

- [ ] **Step 7: Verify read-only enforcement**

Run `/copilot:review --wait` and confirm from `/copilot:status <job-id>` that the session ran in `plan` mode, and that no files in the working tree changed (`git status`).

- [ ] **Step 8: Rescue round trip**

Run `/copilot:rescue investigate why the test in <file> fails`, then a follow-up `/copilot:rescue continue`.
Expected: the first run creates a session; the follow-up offers to continue it and resumes the same session id.

- [ ] **Step 9: Transfer**

Run `/copilot:transfer`.
Expected: a Copilot session id, a `copilot --resume=<id>` command that actually resumes, and output stating plainly that the transfer is a primer.

- [ ] **Step 10: Record what broke and commit any fixes**

```bash
git add -A
git commit -m "fix: address findings from end-to-end acceptance against Copilot CLI"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §5 layout → Tasks 1, 15; §6.1 → Task 1; §6.2 → Task 4; §6.3 read-only → Task 4 (implementation) and Task 16 Step 7 (verification); §6.4 turn capture → Task 4; §6.5 ported modules → Tasks 2, 4, 7, 10; §6.6 background jobs → Task 10; §6.7 usage → Tasks 5, 10, 11, 12; §6.8 model resolution → Task 3; §7.1–7.2 → Task 8; §7.3 → Task 9; §7.4 → Task 14; §7.5 → Task 12; §7.6 → Task 6; §8 subagent → Task 9; §9 skills → Task 9; §10 hooks → Task 13; §11 prompts and schema → Task 8; §12 testing → every task, fixture in Task 1; §13 build order → the phase grouping; §14 risks → RK1 asserted in Task 1 Step 10, RK2 in Task 8 Step 4 and Task 16 Step 4, RK3 in Task 16 Step 7, RK4 in Task 14 Step 1, RK5 in Task 11, RK7/RK8 in Tasks 3 and 11.

**One deliberate gap.** Spec §6.3 requires deriving the read-only `excludedTools` list from `session.tools.getCurrentMetadata` rather than hardcoding it. Task 4 ships a hardcoded starting list, and Task 16 Step 7 verifies read-only behaviour empirically. If Step 7 shows a write path getting through, the fix is to query the live tool roster at that point. This is called out rather than hidden because it is the one place the plan knowingly starts from a guess, and the guess is fenced by plan mode and the deny-by-default permission handler.

**Type consistency.** `sessionId` is used throughout; no `threadId` survives outside the Task 10 rename instruction. `runCopilotTurn` returns `mode` (asserted in Tasks 4 and 9) and `usage` (consumed in Tasks 5, 10, 12). `describeCost` returns `{ model, multiplier, label }` and every caller reads `.label` or `.multiplier`. `normalizeCatalog` produces `{ models, cachedAt }` with `reasoningEfforts` (plural), matching `validateEffort` and `renderSetupReport`. `resolveModel` returns `{ model, source }` and every caller destructures both or one.

**Placeholder scan.** No TBD, TODO, or "add error handling" steps. Every code step carries runnable code. Tasks 7, 10, and 13 direct ports name the exact source path and the exact edits rather than saying "similar to".
