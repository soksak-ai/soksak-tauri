// 파일 뷰 컨테이너도 주소 앵커를 단다 — 안 달면 그 안의 노출 노드가 크롬으로 샌다.
//
// RED 근거(라이브 실측, 2026-07-26): 파일 뷰 3개가 열린 창에서 ui.verify 의 address.unique 가
// `chrome/mode-code ×3` 을 잡았다. FileViewerHost 에 data-view-addr 가 없어서 파일 뷰어
// 플러그인이 노출한 노드가 뷰 컨테이너 스캔에 못 잡히고 크롬 폴백으로 수집됐다 — 파일 뷰
// 수만큼 같은 주소가 생긴다. PluginViewHost 는 viewHostAnchors 로 이미 막고 있던 결함이다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileViewerHost } from "./FileViewerHost";
import { useFileViewerRegistry } from "../plugins/fileViewerRegistry";

// 실제 경로로 검증한다 — 뷰어가 등록돼 마운트하는 상태가 결함이 살던 조건이다.
let unregister: (() => void) | null = null;
beforeEach(() => {
  unregister = useFileViewerRegistry
    .getState()
    .register(
      "test-viewer",
      { id: "md", extensions: ["md"] },
      { mount: (el) => el.appendChild(document.createElement("span")) },
    );
});

let roots: Root[] = [];
let hosts: HTMLElement[] = [];
function mount(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push(root);
  hosts.push(host);
  return host;
}
afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const h of hosts) h.remove();
  roots = [];
  hosts = [];
  unregister?.();
  unregister = null;
});

describe("FileViewerHost 주소 앵커", () => {
  it("컨테이너가 탭 축을 포함한 주소 앵커를 노출한다", () => {
    const host = mount(
      <FileViewerHost path="/x/a.md" projectId="pjt-aaaaaa" root="/x" viewId="tab-cccccc" />,
    );
    const el = host.querySelector(".tab-viewer");
    expect(el?.getAttribute("data-view-addr")).toMatch(/\/tab\/tab-cccccc$/);
  });

  it("파일 뷰 둘은 서로 다른 baseAddress 를 갖는다 — 노드가 크롬으로 새지 않는 조건", () => {
    const a = mount(
      <FileViewerHost path="/x/a.md" projectId="pjt-aaaaaa" root="/x" viewId="tab-aaaaaa" />,
    );
    const b = mount(
      <FileViewerHost path="/x/b.md" projectId="pjt-aaaaaa" root="/x" viewId="tab-bbbbbb" />,
    );
    const addrA = a.querySelector(".tab-viewer")?.getAttribute("data-view-addr");
    const addrB = b.querySelector(".tab-viewer")?.getAttribute("data-view-addr");
    expect(addrA).toBeTruthy();
    expect(addrA).not.toBe(addrB);
  });
});
