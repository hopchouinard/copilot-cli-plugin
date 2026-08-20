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

import fs from "node:fs";
import os from "node:os";

const STUB_CRASH = path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-copilot-crash.mjs");
const STUB_REFUSE = path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-copilot-refuse.mjs");

test("a pending request rejects when the child exits unexpectedly", async () => {
  const client = await CopilotRpcClient.connect(process.cwd(), { binary: STUB_CRASH });
  await assert.rejects(() => client.request("ping", {}), /exited unexpectedly/);
  await client.close();
});

test("request after an unexpected child exit rejects rather than writing to dead stdin", async () => {
  const client = await CopilotRpcClient.connect(process.cwd(), { binary: STUB_CRASH });
  await assert.rejects(() => client.request("ping", {}), /exited unexpectedly/);
  // The child is already gone. A second request must reject immediately
  // instead of writing to a dead stdin (which would emit an unhandled
  // EPIPE 'error' with no listener).
  await assert.rejects(() => client.request("ping", {}), /closed/);
  await client.close();
});

// Regression coverage for the C1 fix in copilot.mjs: runCopilotTurn races
// `capture.promise` against `client.exitPromise` so a copilot process that
// dies mid-turn (with no formal completion event ever sent) still bounds
// the turn instead of hanging forever. That race needs exitPromise to
// actually resolve — with the failure, so the caller can report why —
// rather than staying pending or resolving with nothing useful.
test("exitPromise resolves with the failure when the child exits unexpectedly", async () => {
  const client = await CopilotRpcClient.connect(process.cwd(), { binary: STUB_CRASH });
  // Trigger the crash (the stub exits on any request after connect).
  await assert.rejects(() => client.request("ping", {}), /exited unexpectedly/);
  const failure = await client.exitPromise;
  assert.ok(failure instanceof Error, "expected exitPromise to resolve with the Error, not undefined");
  assert.match(failure.message, /exited unexpectedly/);
  await client.close();
});

test("the handshake-refusal path leaves no live child process", async () => {
  const pidFile = path.join(os.tmpdir(), `copilot-stub-pid-${process.pid}-${Date.now()}`);
  await assert.rejects(
    () =>
      CopilotRpcClient.connect(process.cwd(), {
        binary: STUB_REFUSE,
        env: { ...process.env, STUB_PID_FILE: pidFile }
      }),
    /refused the SDK handshake/
  );

  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  fs.unlinkSync(pidFile);

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    alive = error.code !== "ESRCH";
  }
  assert.equal(alive, false, "expected the stub child process to be terminated");
});
