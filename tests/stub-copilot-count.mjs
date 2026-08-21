#!/usr/bin/env node
// Records every spawn, then dies. Used to count how many times a code path
// attempts to reach Copilot, not whether it succeeds.
import fs from "node:fs";
fs.appendFileSync(process.env.COPILOT_SPAWN_LOG, "spawn\n");
process.exit(1);
