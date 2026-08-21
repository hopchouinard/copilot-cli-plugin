// The plugin's state store location must not depend on which other plugins
// happen to be installed alongside it.
//
// Every plugin's SessionStart hook appends to one shared session env file. The
// reference plugin this one was ported from publishes its data directory there
// under the harness's own name, CLAUDE_PLUGIN_DATA, and this plugin inherited
// that. With two such plugins installed the last SessionStart to run wins, and
// every Bash-run command in the session — including this plugin's — resolves
// its store to the OTHER plugin's directory, while hooks (which the harness
// gives a correct per-plugin value) resolve it to the right one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { run, makeTempDir } from "./helpers.mjs";

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "copilot", "scripts");
const SESSION_HOOK = path.join(SCRIPTS_DIR, "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(SCRIPTS_DIR, "stop-review-gate-hook.mjs");
const STATE_MODULE = path.join(SCRIPTS_DIR, "lib", "state.mjs");

// Env inheritance is the whole subject here, so every child gets an explicitly
// constructed environment rather than a patched copy of this process's.
function baseEnv(overrides) {
  return {
    PATH: path.dirname(process.execPath),
    HOME: makeTempDir("copilot-home-"),
    ...overrides
  };
}

function resolveStoreWith(cwd, env) {
  const script = `
    import { resolveStateFile } from ${JSON.stringify(STATE_MODULE)};
    process.stdout.write(resolveStateFile(process.argv[2]));
  `;
  const scriptPath = path.join(makeTempDir("copilot-probe-"), "probe.mjs");
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = run("node", [scriptPath, cwd], { cwd, env: baseEnv(env) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setConfigWith(cwd, env, key, value) {
  const script = `
    import { setConfig } from ${JSON.stringify(STATE_MODULE)};
    setConfig(process.argv[2], process.argv[3], JSON.parse(process.argv[4]));
  `;
  const scriptPath = path.join(makeTempDir("copilot-write-"), "write.mjs");
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = run("node", [scriptPath, cwd, key, JSON.stringify(value)], { cwd, env: baseEnv(env) });
  assert.equal(result.status, 0, result.stderr);
}

test("this plugin's own variable wins over the shared harness one", () => {
  const cwd = makeTempDir("copilot-ws-");
  const ours = makeTempDir("copilot-data-");
  const neighbour = makeTempDir("other-plugin-data-");

  const resolved = resolveStoreWith(cwd, {
    // Exactly the collision: a neighbouring plugin's SessionStart won the race
    // and published its directory under the shared name.
    CLAUDE_PLUGIN_DATA: neighbour,
    COPILOT_PLUGIN_DATA: ours
  });

  assert.ok(resolved.startsWith(ours), `expected a store under ${ours}, got ${resolved}`);
  assert.equal(resolved.startsWith(neighbour), false, "must never write into a neighbouring plugin's data directory");
});

test("the harness variable is still honoured on its own, which is the hook case", () => {
  const cwd = makeTempDir("copilot-ws-");
  const ours = makeTempDir("copilot-data-");

  // Inside a hook the harness sets CLAUDE_PLUGIN_DATA to THIS plugin's
  // directory and nothing else is set. That value must still be used.
  const resolved = resolveStoreWith(cwd, { CLAUDE_PLUGIN_DATA: ours });

  assert.ok(resolved.startsWith(ours), `expected a store under ${ours}, got ${resolved}`);
});

test("with neither variable set the store falls back to this plugin's own temp root", () => {
  const cwd = makeTempDir("copilot-ws-");
  // Asserted on the marker rather than on this process's os.tmpdir(): the
  // child gets a deliberately minimal environment with no TMPDIR, so its
  // notion of a temp directory is not the parent's.
  const resolved = resolveStoreWith(cwd, {});
  assert.match(resolved, /[\\/]copilot-companion[\\/]/);
  assert.equal(resolved.startsWith(cwd), false, "the store must never land inside the workspace being reviewed");
});

test("SessionStart publishes the plugin's own variable and never clobbers the shared one", () => {
  const cwd = makeTempDir("copilot-ws-");
  const ours = makeTempDir("copilot-data-");
  const envFile = path.join(makeTempDir("copilot-env-"), "env");
  fs.writeFileSync(envFile, "", "utf8");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd,
    env: baseEnv({ CLAUDE_PLUGIN_DATA: ours, CLAUDE_ENV_FILE: envFile }),
    input: JSON.stringify({ session_id: "s1", cwd, transcript_path: "/tmp/t.jsonl" })
  });
  assert.equal(result.status, 0, result.stderr);

  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export COPILOT_PLUGIN_DATA=/, "must publish its own namespaced variable");
  assert.ok(exported.includes(ours), "the published value must be the harness's per-plugin directory");
  assert.equal(
    /export CLAUDE_PLUGIN_DATA=/.test(exported),
    false,
    "must not re-export the shared name — that is what overwrites a neighbouring plugin's store location"
  );
});

test("a command's config reaches the hook that reads it, with a neighbour holding the shared name", () => {
  // The end-to-end reproduction of the reported failure:
  // `/copilot:setup --enable-review-gate` ran as a Bash command with a
  // neighbour's directory in CLAUDE_PLUGIN_DATA, so the flag landed in the
  // neighbour's store, and the Stop hook — reading its own, correct store —
  // saw a disabled gate and let every turn stop unreviewed.
  const cwd = makeTempDir("copilot-ws-");
  const ours = makeTempDir("copilot-data-");
  const neighbour = makeTempDir("other-plugin-data-");

  // Command context: the neighbour won the SessionStart race.
  setConfigWith(cwd, { CLAUDE_PLUGIN_DATA: neighbour, COPILOT_PLUGIN_DATA: ours }, "stopReviewGate", true);

  // Hook context: the harness supplies this plugin's own directory, and
  // nothing else is set.
  const result = run("node", [STOP_HOOK], {
    cwd,
    env: baseEnv({ CLAUDE_PLUGIN_DATA: ours }),
    input: JSON.stringify({ cwd, session_id: "s1" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), "", "the hook saw a disabled gate — it read a different store than the command wrote");
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.decision, "block");

  // And the neighbour's directory was never touched.
  assert.deepEqual(fs.readdirSync(neighbour), [], "a neighbouring plugin's data directory must stay untouched");
});
