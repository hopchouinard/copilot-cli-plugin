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
