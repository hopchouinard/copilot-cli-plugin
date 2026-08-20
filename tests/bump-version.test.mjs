import { test } from "node:test";
import assert from "node:assert/strict";

import { collectVersions, versionsAgree } from "../scripts/bump-version.mjs";

test("versions agree when all three manifests match", () => {
  assert.equal(
    versionsAgree({ package: "1.2.3", plugin: "1.2.3", marketplace: "1.2.3", marketplaceEntry: "1.2.3" }),
    true
  );
});

test("versions disagree when one manifest drifts", () => {
  assert.equal(
    versionsAgree({ package: "1.2.3", plugin: "1.2.4", marketplace: "1.2.3", marketplaceEntry: "1.2.3" }),
    false
  );
});

test("collectVersions reads all three manifests from the repo root", () => {
  const versions = collectVersions(process.cwd());
  assert.ok(versions.package);
  assert.ok(versions.plugin);
  assert.ok(versions.marketplace);
});
