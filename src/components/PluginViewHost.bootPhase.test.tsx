// 미등록 뷰의 3상 계약 — "빈칸"과 "곧 채워질 자리"는 다른 사실이다(사용자 확정 2026-07-27:
// 뭐가 뜰 건지 아니면 그냥 빈칸인지 알아야 착각을 안 한다).
//
// RED 근거: 복원이 플러그인 호스트보다 먼저 서는 부트(복원 300ms 기준)에서, 활성화가 끝나기
// 전의 미등록 뷰가 "플러그인 뷰 없음"으로 그려졌다 — 곧 채워질 자리를 부재로 말하는 거짓말.
// 계약: ready 전 미등록 = plugin-loading(불러오는 중), ready 후 미등록 = plugin-empty(진짜 부재).
import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { FileViewerHost } from "./FileViewerHost";
import { useViewRegistry } from "../plugins/viewRegistry";
import { useFileViewerRegistry } from "../plugins/fileViewerRegistry";
import { useBootPhase } from "../state/bootPhase";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function mountHost(host: HTMLElement): Root {
  const root = createRoot(host);
  act(() => {
    root.render(
      <PluginViewHost
        viewKey="nope.canvas"
        projectId="p1"
        root={null}
        region="content"
      />,
    );
  });
  return root;
}

describe("PluginViewHost — 미등록 뷰의 부트 3상", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
    useBootPhase.setState({ phase: "ready" });
    root?.unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("부트 진행 중(restoring/activating)의 미등록은 '불러오는 중'이다 — 부재가 아니다", () => {
    for (const phase of ["restoring", "activating"] as const) {
      act(() => useBootPhase.setState({ phase }));
      root = mountHost(host);
      expect(host.querySelector(".plugin-loading"), phase).not.toBeNull();
      expect(host.querySelector(".plugin-empty"), phase).toBeNull();
      act(() => root!.unmount());
    }
  });

  it("ready 후의 미등록만 진짜 부재(plugin-empty)다", () => {
    root = mountHost(host);
    expect(host.querySelector(".plugin-empty")).not.toBeNull();
    expect(host.querySelector(".plugin-loading")).toBeNull();
  });

  it("ready 전이가 오면 로딩 표시는 그 자리에서 부재/등록으로 해소된다", () => {
    act(() => useBootPhase.setState({ phase: "activating" }));
    root = mountHost(host);
    expect(host.querySelector(".plugin-loading")).not.toBeNull();
    act(() => useBootPhase.setState({ phase: "ready" }));
    expect(host.querySelector(".plugin-loading")).toBeNull();
    expect(host.querySelector(".plugin-empty")).not.toBeNull();
  });

  it("파일 뷰(FileViewerHost)도 같은 계약이다 — 에디터 자리도 부트 중엔 '불러오는 중'", () => {
    // RED 근거(사용자 실측 2026-07-27): 부트 중 파일 탭이 "플러그인 뷰 없음"으로 떴다 —
    // 오류로 읽히는 표시는 정말 문제일 때(활성화 완료 후 미등록)만 보여야 한다.
    useFileViewerRegistry.setState({ viewers: {}, version: 0 });
    act(() => useBootPhase.setState({ phase: "activating" }));
    root = createRoot(host);
    act(() => {
      root!.render(
        <FileViewerHost path="/tmp/x.md" projectId="p1" root={null} viewId="v1" />,
      );
    });
    expect(host.querySelector(".plugin-loading")).not.toBeNull();
    expect(host.querySelector(".plugin-empty")).toBeNull();
    act(() => useBootPhase.setState({ phase: "ready" }));
    expect(host.querySelector(".plugin-empty")).not.toBeNull();
  });
});
