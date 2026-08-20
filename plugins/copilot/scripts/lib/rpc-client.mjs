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
    this.serverRequestHandler = null;
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

    this.proc.stdin.on("error", () => {
      // A write can race a child that has already exited (EPIPE/ECONNRESET).
      // request()/notify() guard against writing once the exit is observed,
      // but a write can still be in flight when the child dies; swallow it
      // here so it never becomes an unhandled EventEmitter error that takes
      // down the host process.
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
        this.forceKillProcess();
        this.handleExit(error);
        return;
      }
      for (const message of messages) {
        this.handleMessage(message);
      }
    });

    const handshake = await this.request("connect", { protocolVersion: REQUIRED_PROTOCOL_VERSION });
    if (!handshake?.ok) {
      await this.forceKillProcess();
      throw new Error("Copilot CLI refused the SDK handshake.");
    }
    if (Number(handshake.protocolVersion) < REQUIRED_PROTOCOL_VERSION) {
      await this.forceKillProcess();
      throw new Error(
        `Copilot CLI speaks protocol ${handshake.protocolVersion}; this plugin needs ${REQUIRED_PROTOCOL_VERSION}. Update with \`npm install -g @github/copilot\`.`
      );
    }
    this.serverVersion = handshake.version ?? null;
  }

  handleMessage(message) {
    // A message carrying both an `id` and a `method` is a server→client
    // *request* — the server is asking us something (e.g. tool-call
    // permission under `requestPermission: true`) and is blocked waiting
    // for a reply with that same `id`. This must never be routed to the
    // notification handler: notifications have no `id` and expect no
    // reply, so silently treating a request as one leaves the server
    // waiting forever. This was exactly the cause of the read-only
    // permission deadlock discovered in acceptance testing (Task 16):
    // every server request was dropped as a notification and never
    // answered.
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

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

  // Answers a server→client request. A request must always get a reply —
  // an unanswered one blocks the server's turn indefinitely, with no
  // timeout and no visible error. If no handler is registered, or the
  // handler throws (e.g. it doesn't recognise the method), reply with an
  // explicit JSON-RPC error rather than staying silent — an error at
  // least lets the server's turn fail loudly instead of hanging.
  handleServerRequest(message) {
    const respond = (result) => {
      if (this.closed || this.exitResolved) {
        return;
      }
      this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id: message.id, result: result ?? null }));
    };
    const respondError = (code, errorMessage) => {
      if (this.closed || this.exitResolved) {
        return;
      }
      this.proc.stdin.write(
        encodeMessage({ jsonrpc: "2.0", id: message.id, error: { code, message: errorMessage } })
      );
    };

    if (!this.serverRequestHandler) {
      respondError(-32601, `No handler registered for server request: ${message.method}`);
      return;
    }

    Promise.resolve()
      .then(() => this.serverRequestHandler(message))
      .then(respond)
      .catch((error) =>
        respondError(-32603, error instanceof Error ? error.message : String(error))
      );
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
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
    if (this.closed || this.exitResolved) {
      return Promise.reject(new Error("copilot rpc client is closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  async forceKillProcess(signal = "SIGTERM") {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    proc.kill(signal);
    const escalate = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
    }, 200);
    escalate.unref?.();
    await exited;
    clearTimeout(escalate);
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
