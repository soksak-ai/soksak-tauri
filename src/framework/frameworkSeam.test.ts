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

/**
 * 실물 import/require 만 센다 — 주석 속 서술(경계의 근거를 적은 글)은 규칙이 아니다.
 *
 * **상대 경로는 벤더가 아니다.** 우리 폴더 이름이 벤더 패키지 이름과 같을 수 있다
 * (`src/framework/electron/`) — 경로로 가르지 않으면 자기 집을 벤더로 신고한다
 * (실측 2026-08-03: `../framework/electron/contentViews` 가 위반으로 잡혔다).
 * 패키지 지정자는 `.` 이나 `/` 로 시작하지 않는다.
 */
function vendorImports(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    const m = code.match(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/);
    if (!m) continue;
    if (m[1].startsWith(".") || m[1].startsWith("/")) continue;
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

/**
 * 프레임워크가 자기 사정으로 거는 **장치**도 코어에 남으면 안 된다.
 *
 * import 게이트는 벤더 SDK 만 본다. 그런데 장치는 벤더를 안 물고도 샌다 — 명령 이름 하나,
 * 사건 이름 하나면 된다. 그 이름들은 **문서 밖에 표면이 있다**는 전제 위에 서 있고, 그 전제가
 * 없는 프레임워크에서는 없는 개념에 대한 호출이다. 거절을 삼키면 조용해지고, 안 삼키면 부팅
 * 원장이 실패로 물든다 — 그리고 삼키든 아니든 **멀쩡한 판을 가리고 비운다**(실측 2026-08-03:
 * 판 활성 전이의 한 프레임에서 브라우저 판 둘이 통째로 비었다).
 *
 * 그래서 규칙은 하나다: 코어 표면은 둘 다 동일하고, 그 표면에 자기 것을 거는 것은 각
 * 프레임워크다(framework/<name>/install.ts). 코어는 무엇이 걸렸는지 묻지 않는다.
 */
describe("프레임워크 장치는 자기 집에만 산다", () => {
  /** 문서 밖 표면을 전제하는 이름들 — 있는 자리는 그 프레임워크의 폴더뿐이다. */
  const DEVICE_NAMES: [RegExp, string][] = [
    [/webview_dom_holes/, "홀 목록 — 문서 밖 표면 아래의 마우스 소유"],
    [/webview_overlay_active/, "오버레이 히트테스트 게이트 — 표면이 마우스를 가져가는 것을 막는다"],
    [/webview_divider_highlight/, "골 강조바 — DOM 강조가 표면에 가려질 때만 필요하다"],
    [/webview_resize_gesture/, "리사이즈 위상 릴레이 — 네이티브 쪽에만 필요하다"],
    [/webview\.composition/, "DOM 홀↔NSView frame 정합 — 문서 밖 표면에만 존재한다"],
    // `plugin:webview-capture|*` 는 여기 없다 — **공통 능력**이다(window.snapshot·record). 두
    // 프레임워크가 다 답하며, 이름만 한쪽 프레임워크의 플러그인 문법을 닮았을 뿐이다. 그 이름을
    // 고치는 것은 어휘의 빚이고 이 규칙의 축이 아니다 — 여기서 금지하면 멀쩡한 공통 능력이
    // 프레임워크 폴더로 밀려난다.
    [/["']native-mouse/, "네이티브 마우스 모니터 — 표면 위의 입력이 이 문서에 안 올 때만 필요하다"],
  ];

  function walkSrc(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkSrc(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it("코어는 문서 밖 표면 전용 명령·사건을 부르지 않는다", () => {
    const files = walkSrc(SRC).map((f) => relative(SRC, f));
    // 오라클 생존 — 훑은 파일이 없으면 아래 단언이 공짜로 통과한다.
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel.split("/")[0] === ADAPTER_DIR) continue;
      const src = readFileSync(join(SRC, rel), "utf8");
      // 주석은 벗긴다 — 경계의 근거를 적은 글이 위반으로 잡히면 규칙이 자기 근거를 지운다.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const [re, why] of DEVICE_NAMES) {
        if (re.test(code)) offenders.push(`${rel} → ${re.source} (${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 홀은 **문서 밖에 표면이 있을 때만** 뜻이 있다. 그 규칙이 코어 스타일시트에 있으면 어느
   * 프레임워크에서든 문서에 서고, 뚫을 것이 없는 곳에서 멀쩡한 판을 뚫는다.
   *
   * Tauri private marker를 거는 것도 그 어댑터다. 코어는 hole 개념을 만들거나 해석하지 않는다.
   */
  it("코어 스타일시트는 홀을 그리지 않는다", () => {
    const css = readFileSync(join(SRC, "App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
    const drawing = rules.filter((sel) => /\.hole\b|data-tauri-hole/.test(sel));
    expect(drawing).toEqual([]);
    // 오라클 생존 — 규칙을 하나도 못 읽었으면 위 단언이 공짜로 통과한다.
    expect(rules.length).toBeGreaterThan(100);
  });
});
