// 빌드 산출물 경계 — 선택하지 않은 프레임워크의 SDK·어댑터 표식이 한 바이트라도 있으면 실패한다.
// 소스 import 검사만으로는 Vite plugin/간접 재수출 누수를 못 잡으므로 실제 산출물을 읽는다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const FORBIDDEN = {
  electron: [
    ["__TAURI_INTERNALS__", "Tauri 런타임"],
    ["@tauri-apps", "Tauri SDK"],
    ["webview_dom_holes", "Tauri DOM-hole 명령"],
    ["Tauri 프레임워크 어댑터", "Tauri 어댑터 본문"],
  ],
  tauri: [
    ["Electron 프레임워크 창구", "Electron 어댑터 본문"],
    ["framework/electron.fix", "Electron 렌더러 상태"],
    ["electron.css", "Electron 전용 스타일"],
  ],
};

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(?:html|css|js)$/.test(name)) out.push(path);
  }
  return out;
}

export function artifactViolations(framework, dist = resolve(ROOT, "dist", framework)) {
  const files = filesUnder(dist);
  if (files.length === 0) throw new Error(`${framework} 산출물이 비어 있습니다: ${dist}`);
  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [needle, why] of FORBIDDEN[framework]) {
      if (source.includes(needle)) violations.push(`${file}: ${why} (${needle})`);
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = [
    ...artifactViolations("electron"),
    ...artifactViolations("tauri"),
  ];
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("framework artifact isolation: GREEN");
}
