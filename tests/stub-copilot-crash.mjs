#!/usr/bin/env node
// Stub Copilot process for rpc-client death-path tests: completes the
// connect handshake normally, then exits abruptly (without responding) on
// the next request, simulating a mid-session crash.
import process from "node:process";

import { encodeMessage, createMessageDecoder } from "../plugins/copilot/scripts/lib/rpc-client.mjs";

function send(message) {
  process.stdout.write(encodeMessage(message));
}

const decode = createMessageDecoder();
process.stdin.on("data", (chunk) => {
  for (const message of decode(chunk)) {
    if (message.method === "connect") {
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true, protocolVersion: 3, version: "1.0.80" } });
      continue;
    }
    // Any request after connect: crash without responding.
    process.exit(1);
  }
});
