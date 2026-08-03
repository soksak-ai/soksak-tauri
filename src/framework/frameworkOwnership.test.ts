// 프레임워크 소유권 계약 — DOM 밖 네이티브 표면을 보정하는 장치는 Tauri 구현이다.
// 공통 코드가 이름이나 수명 호출을 알면 Electron도 그 판정의 영향을 받으므로 위치 자체를 막는다.
// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = resolve(ROOT, "src");
const TAURI_FIXES = [
  "railHoleClip.ts",
  "railHoleClipHost.ts",
  "surfaceAudit.ts",
];

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) productionFiles(path, out);
    else if (/\.(?:ts|tsx|css)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

describe("Tauri native-composition ownership", () => {
  it("보정 구현은 framework/tauri 밖에 존재하지 않는다", () => {
    const misplaced = TAURI_FIXES.filter((name) => existsSync(resolve(SRC, "lib", name)));
    expect(misplaced).toEqual([]);
    for (const name of TAURI_FIXES) {
      expect(existsSync(resolve(SRC, "framework/tauri", name)), name).toBe(true);
    }
  });

  it("공통 App과 플러그인 API가 native-motion·hole-clip 수명을 호출하지 않는다", () => {
    const files = ["src/App.tsx", "src/plugins/api.ts"];
    const offenders = files.filter((file) =>
      /nativeMotion|railHoleClip|webview_animate_bounds/.test(
        readFileSync(resolve(ROOT, file), "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("공통 DOM과 스타일은 Tauri hole 표식을 만들거나 해석하지 않는다", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith("framework/tauri/")) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (
        /(?:^|[^\w-])\.hole\b|classList\.(?:add|contains)\(["']hole["']\)|isHoleView|["'] hole["']/m.test(
          source,
        )
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("공통 DOM 파킹은 일반 DOM 가시성만 쓰고 좌표·z-index 보정을 하지 않는다", () => {
    const source = readFileSync(resolve(SRC, "lib/layerPark.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/translate|zIndex|z-index|OFFSCREEN/);
  });

  it("폐기한 PNG·veil 합성 계약은 제품 코드에 남지 않는다", () => {
    const offenders = productionFiles(SRC)
      .filter((file) => /slotFreeze|content-view\.veiled|webview_snapshot/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("native surface 이동은 bounds만 쓰고 z-order handoff나 frame animation을 만들지 않는다", () => {
    const sources = [
      "frameworks/tauri/src/webview.rs",
      "frameworks/tauri/src/lib.rs",
      "frameworks/tauri/Cargo.toml",
    ].map((file) => readFileSync(resolve(ROOT, file), "utf8")).join("\n");
    expect(sources).not.toMatch(/webview_surface_handoff/);
    expect(sources).not.toMatch(/webview_animate_bounds/);
    expect(sources).not.toMatch(/CABasicAnimation|CAAnimationDelegate|CATransaction/);
    const outsideTauri = productionFiles(SRC)
      .filter((file) => !relative(SRC, file).startsWith("framework/tauri/"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(outsideTauri).not.toMatch(/webview_animate_bounds|CABasicAnimation|CATransaction/);
  });

  it("WKWebView 자체가 아니라 전용 layer-backed surface host만 배치한다", () => {
    const source = readFileSync(resolve(ROOT, "frameworks/tauri/src/webview.rs"), "utf8");
    expect(source).toMatch(/adopt_surface_host/);
    expect(source).toMatch(/surface_host_ptr/);
    expect(source).toMatch(/host\.setFrame/);
    expect(source).not.toMatch(/host\.animator\(\)\.setFrame/);
    expect(source).not.toMatch(/view\.animator\(\)\.setFrame/);
  });

  it("surface host의 정상 z-order는 고정하고 overlay 상태만 명시적으로 전환한다", () => {
    const source = readFileSync(resolve(ROOT, "frameworks/tauri/src/webview.rs"), "utf8");
    expect(source).toMatch(/raise_surface_host/);
    expect(source).toMatch(/lower_surface_host/);
    expect(source).not.toMatch(/webview_surface_handoff/);
    expect(source).toMatch(/if active \{[\s\S]*lower_window_surface_hosts/);
    expect(source).toMatch(/else \{[\s\S]*raise_window_surface_hosts/);
  });

  it("native bounds command는 main-thread frame 설치 ACK 뒤에만 반환한다", () => {
    const source = readFileSync(resolve(ROOT, "frameworks/tauri/src/webview.rs"), "utf8");
    const body = source.split("fn set_child_frame(")[1]?.split("#[cfg(not(target_os = \"macos\"))]")[0] ?? "";
    expect(body).toMatch(/sync_channel/);
    expect(body).toMatch(/recv_timeout/);
    expect(body).toMatch(/applied_tx\.send/);
  });
});
