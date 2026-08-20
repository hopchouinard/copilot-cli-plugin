#!/usr/bin/env node
// Stub Copilot process for rpc-client death-path tests: answers connect
// with a refusal and otherwise keeps running (it never exits on its own),
// so tests can assert the client force-terminates it. Writes its own PID to
// STUB_PID_FILE, if set, so the test can verify it after connect() rejects.
import fs from "node:fs";
import process from "node:process";

import { encodeMessage, createMessageDecoder } from "../plugins/copilot/scripts/lib/rpc-client.mjs";

if (process.env.STUB_PID_FILE) {
  fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
}

function send(message) {
  process.stdout.write(encodeMessage(message));
}

const decode = createMessageDecoder();
process.stdin.on("data", (chunk) => {
  for (const message of decode(chunk)) {
    if (message.method === "connect") {
      send({ jsonrpc: "2.0", id: message.id, result: { ok: false } });
    }
  }
});
