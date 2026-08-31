// The current record describes this repository by its own rules and evidence.
//
// Dated checkout locations and predecessor implementations are not durable evidence: the
// checkout can move, and the predecessor cannot be inspected from this repository. Legal
// attribution and provider wire names remain valid; this gate targets only the stale forms that
// previously replaced a local rule with a machine path or an outside implementation.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

const SELF = new Set([
  "scripts/gates/current-record-provenance.mjs",
  "scripts/gates/current-record-provenance.test.mjs",
]);

export const FORBIDDEN_RECORD_FORMS = Object.freeze([
  { name: "former checkout root", pattern: /<machine-path>\/ai\/cli(?:\/|\b)/ },
  { name: "encoded personal checkout", pattern: /-Users-max-/ },
  { name: "former workspace fixture", pattern: /\/workspace\/ai\/cli\/vsterm-tauri/ },
  { name: "former home checkout", pattern: /~\/ai\/cli\// },
  { name: "predecessor implementation", pattern: /구 vtuber claudeCli\.ts/ },
  { name: "outside addon derivation", pattern: /Based on xterm\.js PR #5704/ },
  { name: "outside design derivation", pattern: /This is Meta's Astryx design system/ },
  {
    name: "outside design document",
    pattern: /official Meta(?: design)? docs|Meta's token-efficient compression/,
  },
  { name: "upstream implementation recipe", pattern: /upstream `src\/index\.ts`|upstream PR #1/ },
]);

export function recordResidue(source, forms = FORBIDDEN_RECORD_FORMS) {
  const found = [];
  for (const [index, line] of source.split("\n").entries()) {
    for (const form of forms) {
      if (form.pattern.test(line)) found.push({ line: index + 1, name: form.name, text: line.trim() });
    }
  }
  return found;
}

export function trackedTextFiles(root = REPO_ROOT) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root });
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function scanCurrentRecord(root = REPO_ROOT) {
  const found = [];
  for (const path of trackedTextFiles(root)) {
    if (SELF.has(path)) continue;
    const bytes = readFileSync(resolve(root, path));
    if (bytes.includes(0)) continue;
    const source = bytes.toString("utf8");
    for (const hit of recordResidue(source)) found.push({ path, ...hit });
  }
  return found;
}

function main() {
  const found = scanCurrentRecord();
  if (found.length > 0) {
    for (const hit of found) {
      console.error(`current-record: ${hit.path}:${hit.line} ${hit.name}: ${hit.text}`);
    }
    return 1;
  }
  console.log("current-record: OK — tracked text names no former checkout or predecessor implementation");
  return 0;
}

if (basename(process.argv[1] || "") === "current-record-provenance.mjs") {
  process.exitCode = main();
}
