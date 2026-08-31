// Cargo path dependencies may join packages inside this repository. A manifest may not infer the
// checkout location of another repository; independently owned packages use a declared immutable
// source coordinate instead.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

export function cargoPathEscapes(manifest, source, root = REPO_ROOT) {
  const manifestRoot = dirname(resolve(root, manifest));
  const escaped = [];
  for (const match of source.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
    const declared = match[1];
    const resolved = resolve(manifestRoot, declared);
    const fromRoot = relative(root, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      escaped.push({ manifest, declared, resolved });
    }
  }
  return escaped;
}

export function scanCargoPathBoundaries(root = REPO_ROOT) {
  const files = execFileSync("git", ["ls-files", "-z", "*Cargo.toml"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return files.flatMap((manifest) =>
    cargoPathEscapes(manifest, readFileSync(resolve(root, manifest), "utf8"), root),
  );
}

function main() {
  const escaped = scanCargoPathBoundaries();
  if (escaped.length > 0) {
    for (const finding of escaped) {
      console.error(`cargo-path-boundary: ${finding.manifest} declares ${finding.declared}`);
    }
    return 1;
  }
  console.log("cargo-path-boundary: OK — every Cargo path remains inside this repository");
  return 0;
}

if (basename(process.argv[1] || "") === "cargo-path-boundary.mjs") {
  process.exitCode = main();
}
