import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { onPluginEvent } from "../plugins/hooks";
import { useShellLayoutReflow } from "./shellLayoutReflow";

let host: HTMLDivElement;
let root: Root;

function Probe({ geometry, activeSpaceId }: { geometry: string; activeSpaceId: string | null }) {
  useShellLayoutReflow(geometry, activeSpaceId);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("프로젝트 탭 위치처럼 ProjectSurface 바깥 셸 기하가 바뀌면 커밋 직후 reflow를 발행한다", () => {
  const seen: Array<string | null> = [];
  const off = onPluginEvent("layout.reflow", (payload) => seen.push(payload.activeSpaceId));
  try {
    act(() => root.render(<Probe geometry="top" activeSpaceId="spc-1" />));
    expect(seen).toEqual(["spc-1"]);

    // 같은 기하의 일반 재렌더는 사건이 아니다.
    act(() => root.render(<Probe geometry="top" activeSpaceId="spc-1" />));
    expect(seen).toEqual(["spc-1"]);

    act(() => root.render(<Probe geometry="left" activeSpaceId="spc-1" />));
    expect(seen).toEqual(["spc-1", "spc-1"]);
  } finally {
    off.dispose();
  }
});
