// 결부(binding)가 바뀌면 뷰가 안다 — ctx 데이터 축의 단일 규칙.
//
// 여태 이 판정은 호스트 안에 필드 이름 목록으로 손배선돼 있었다: root·viewId·command 는 remount
// 키에, paneId 만 update+remount 둘 다, boundViewId 는 어디에도. 목록을 손으로 쓰면 새 필드는
// 조용히 빠지고, 빠진 필드는 "결부는 바뀌었는데 화면은 옛 것"으로 나타난다.
//
// 실측(2026-07-31): shared 투영은 결부가 오가도 같은 인스턴스를 유지하는데(instanceKey 에 결부
// 뷰 id 가 없다), 결부 전환이 remount 도 update 도 일으키지 않아 직전 뷰의 화면이 그대로 남았다.
// 사용자가 본 것 = "같은 화면이 각각의 탭에 같게 보였다가 정상적으로 달라진다".
//
// 씨앗(seed) 축은 반대 방향의 단언이다 — 뷰 자신이 되쓰는 값(setRestoreState → restore)을
// 트리거로 삼으면 보고→remount→재보고의 고리가 된다. 그래서 트리거가 "아님"을 못 박는다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry, type PluginViewContext } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";
import { BINDING_KEYS, VIEW_CONTEXT_AXIS } from "../plugins/viewContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DECL = {
  id: "list",
  title: { en: "L" },
  icon: "▤",
  placements: ["left"],
  defaultPlacement: "left",
  transparent: false,
  nativeSurface: false,
} as unknown as ContributedView;

interface Log {
  mounts: PluginViewContext[];
  updates: PluginViewContext[];
}

function makeProvider(withUpdate: boolean): {
  provider: Record<string, unknown>;
  log: Log;
} {
  const log: Log = { mounts: [], updates: [] };
  const provider: Record<string, unknown> = {
    mount(_el: HTMLElement, ctx: PluginViewContext) {
      log.mounts.push({ ...ctx });
    },
    unmount() {},
  };
  if (withUpdate) {
    provider.update = (_el: HTMLElement, ctx: PluginViewContext) => {
      log.updates.push({ ...ctx });
    };
  }
  return { provider, log };
}

describe("PluginViewHost — 결부가 바뀌면 뷰가 안다", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host.remove();
  });

  /** boundViewId 만 다른 두 번의 렌더. */
  function renderWith(boundViewId: string): void {
    act(() => {
      root!.render(
        <PluginViewHost
          viewKey="p.list"
          projectId="p1"
          root="/r"
          region="left"
          boundViewId={boundViewId}
        />,
      );
    });
  }

  it("update 를 구현한 provider 는 결부 변경을 새 ctx 로 통보받는다", () => {
    const { provider, log } = makeProvider(true);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    renderWith("v-a");
    const updatesAfterMount = log.updates.length;

    renderWith("v-b");

    // 계약: 결부가 바뀌었으면 뷰가 안다. 통보 채널은 update(remount 아님 — 인스턴스 유지).
    expect(log.updates.length).toBeGreaterThan(updatesAfterMount);
    expect(log.updates[log.updates.length - 1]?.boundViewId).toBe("v-b");
    // 인스턴스는 유지된다 — shared 투영이 구조 상태를 지키는 근거.
    expect(log.mounts.length).toBe(1);
  });

  it("update 미구현 provider 는 결부 변경에 remount 된다", () => {
    const { provider, log } = makeProvider(false);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    renderWith("v-a");
    expect(log.mounts.length).toBe(1);

    renderWith("v-b");

    // 통보 수단이 없는 provider 에게 남은 정직한 길은 재생성뿐이다 — 남의 결부 데이터를
    // 계속 그리는 것보다 구조 상태를 잃는 편이 옳다.
    expect(log.mounts.length).toBe(2);
    expect(log.mounts[log.mounts.length - 1]?.boundViewId).toBe("v-b");
  });

  // 축 전수성 — 컴파일이 등재를 강제하지만(satisfies), 그 강제는 tsc 가 도는 곳에서만 산다.
  // 여기서는 **호스트가 실제로 건네는 ctx** 를 오라클로 쓴다: 손 픽스처는 계약과 갈릴 수 있고,
  // 갈린 픽스처는 통과하면서 진짜 필드를 놓친다.
  it("호스트가 건네는 ctx 의 값 필드는 전부 축에 등재돼 있다", () => {
    const { provider, log } = makeProvider(false);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    renderWith("v-a");

    const ctx = log.mounts[0] as unknown as Record<string, unknown>;
    const dataKeys = Object.keys(ctx).filter(
      (k) => typeof ctx[k] !== "function",
    );
    // 오라클 생존 — 값 필드를 하나도 못 읽으면 이 검사는 판정할 수 없다("0 의 두 얼굴").
    expect(dataKeys.length).toBeGreaterThan(0);
    expect(BINDING_KEYS.length).toBeGreaterThan(0);

    const undeclared = dataKeys.filter((k) => !(k in VIEW_CONTEXT_AXIS));
    expect(undeclared).toEqual([]);
  });

  it("씨앗(restore) 변경은 remount 도 update 도 일으키지 않는다", () => {
    const { provider, log } = makeProvider(true);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    const render = (state: unknown): void => {
      act(() => {
        root!.render(
          <PluginViewHost
            viewKey="p.list"
            projectId="p1"
            root="/r"
            region="content"
            viewId="v-a"
            restore={{ cwd: "/r", state }}
          />,
        );
      });
    };
    render({ url: "a" });
    const mounts = log.mounts.length;
    const updates = log.updates.length;

    // setRestoreState 가 만든 되먹임 — 뷰가 보고한 값이 prop 으로 돌아온다.
    render({ url: "b" });

    expect(log.mounts.length).toBe(mounts);
    expect(log.updates.length).toBe(updates);
  });
});
