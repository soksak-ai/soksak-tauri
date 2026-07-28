// @vitest-environment node
// 프레임워크 경계 게이트(정적) — 앱 코드는 프레임워크 벤더 SDK 를 몰라야 한다.
//
// 이 게이트가 없으면 경계는 하루 만에 샌다: 새 파일 하나가 편의로 `@tauri-apps` 를 직접
// import 하는 순간 프레임워크는 다시 교체 불가능한 전제가 된다(실측 2026-07-27, 경계 도입 전:
// 벤더를 직접 물던 앱 파일 57개). 규칙은 문서가 아니라 여기서 시행된다.
//
// 허용 구역은 어댑터뿐이다. 새 프레임워크를 붙이는 일은 `src/framework/<name>.ts` 를 하나 더
// 두는 것으로 끝나야 하며, 앱 코드는 한 줄도 바뀌지 않아야 한다.
import { describe, expect, it } from "vitest";
import { leaksIn } from "./seamSweep";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 프레임워크 벤더 패키지 — 앱 코드가 직접 알면 안 되는 것들. */
const VENDOR = [/@tauri-apps\//, /\belectron\b/];

/** 벤더를 알아도 되는 파일: 어댑터와 그 계약. 그 외에는 없다. */
const ADAPTER_DIR = "framework";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 실물 import/require 만 센다 — 주석 속 서술(경계의 근거를 적은 글)은 규칙이 아니다. */
function vendorImports(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    const m = code.match(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/);
    if (!m) continue;
    if (VENDOR.some((re) => re.test(m[1]))) hits.push(m[1]);
  }
  return hits;
}

describe("프레임워크 경계 — 벤더 SDK 는 어댑터만 안다", () => {
  it("어댑터 밖의 앱 코드는 프레임워크 벤더를 직접 import 하지 않는다", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.split("/")[0] === ADAPTER_DIR) continue;
      const hits = vendorImports(readFileSync(file, "utf8"));
      if (hits.length) offenders.push(`${rel} → ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("어댑터는 계약을 전부 구현한다 — 빈칸은 결국 벤더 우회로 메워진다", async () => {
    const { tauriFramework } = await import("./tauri");
    for (const key of [
      "name",
      "invoke",
      "createStream",
      "listen",
      "currentWindow",
      "windowByLabel",
      "app",
      "path",
      "dialog",
      "notification",
      "deepLink",
    ]) {
      expect(tauriFramework[key as keyof typeof tauriFramework]).toBeDefined();
    }
  });
  /**
   * 벤더는 import 로만 새지 않는다 — **선언**으로도 샌다.
   *
   * 실측(2026-07-28): 헤더가 안 끌렸다. 앱이 `data-tauri-drag-region` 을 네 곳에 쓰고 있었는데
   * 그것은 Tauri 웹뷰가 가로채는 속성이라 다른 프레임워크에서는 그냥 뜻 없는 속성이다.
   * 던지지도 로그를 남기지도 않는다 — 창이 안 움직일 뿐이다. import 게이트는 통과시켰다.
   *
   * 종류는 seamSweep.ts 가 소유한다(새 프레임워크를 붙이면 그쪽 것도 거기 적는다).
   * CSS·HTML 까지 훑는다 — 선언적 누출은 거기로도 샌다.
   */
  it("어댑터 밖의 앱 코드는 벤더 전용 선언을 쓰지 않는다", () => {
    const SWEPT = /\.(ts|tsx|css|html)$/;
    const files: string[] = [];
    const walkAll = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkAll(p);
        else if (SWEPT.test(name)) files.push(p);
      }
    };
    walkAll(SRC);
    // 오라클 생존 — 훑은 파일이 없으면 아래 단언이 공짜로 통과한다.
    expect(files.length).toBeGreaterThan(50);

    const hits = files
      .map((f) => relative(SRC, f))
      .filter((rel) => !rel.startsWith(ADAPTER_DIR))
      .flatMap((rel) => leaksIn(rel, readFileSync(join(SRC, rel), "utf8")));
    expect(hits).toEqual([]);
  });
});
