// 주소 공리 A1·A2 — 유일성과 무추측.
//
// RED 근거(실측, 2026-07-26): 라이브 창의 노출 노드 779개 중 85개가 주소를 공유했다
// (tab/view/0 이 패널 6개에 하나씩, 브라우저 뷰 3개가 같은 urlbar 주소). resolve 는 그중
// "보이는 것"을 골라 추측했는데, 패널이 전부 보이는 지금은 그 추측조차 무너진다 —
// 클릭이 어느 패널로 갈지 아무도 모른다.
//
// 계약은 이미 "계층 경로가 유일(중복0)"을 선언한다. 선언만 있고 시행이 없었다.
// 여기서 시행한다: 같은 주소가 둘이면 고르지 않고 AMBIGUOUS 로 거절한다.
import { beforeEach, describe, expect, it } from "vitest";
import { resolveExposed, collectExposed } from "./catalogDom";

function mountView(addr: string, nodes: string[]): void {
  const c = document.createElement("div");
  c.className = "plugin-view-container";
  c.dataset.viewAddr = addr;
  for (const n of nodes) {
    const el = document.createElement("div");
    el.setAttribute("data-node", n);
    c.appendChild(el);
  }
  document.body.appendChild(c);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("A1 유일성 — 같은 주소를 두 노드가 가질 수 없다", () => {
  it("같은 뷰키를 두 번 마운트해도 inst 축이 주소를 가른다", () => {
    mountView("content/view/p.browser/inst/v6", ["urlbar"]);
    mountView("content/view/p.browser/inst/v36", ["urlbar"]);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

describe("A2 무추측 — 0개면 없음, 2개 이상이면 모호", () => {
  it("유일하면 그것을 준다", () => {
    mountView("content/view/p.browser/inst/v6", ["urlbar"]);
    const r = resolveExposed("content/view/p.browser/inst/v6/node/urlbar");
    expect("el" in r).toBe(true);
  });

  it("없으면 NOT_EXPOSED — selector 로 추측하지 않는다", () => {
    const r = resolveExposed("content/view/p.browser/inst/v6/node/urlbar");
    expect(r).toMatchObject({ code: "NOT_EXPOSED" });
  });

  it("둘이면 AMBIGUOUS — 보이는 쪽을 고르지 않는다", () => {
    mountView("content/view/p.browser", ["urlbar"]);
    mountView("content/view/p.browser", ["urlbar"]);
    const r = resolveExposed("content/view/p.browser/node/urlbar");
    expect(r).toMatchObject({ code: "AMBIGUOUS" });
  });

  it("모호 메시지는 몇 개가 걸렸는지 말한다 — 진단 가능해야 고친다", () => {
    mountView("content/view/p.browser", ["urlbar"]);
    mountView("content/view/p.browser", ["urlbar"]);
    mountView("content/view/p.browser", ["urlbar"]);
    const r = resolveExposed("content/view/p.browser/node/urlbar");
    expect("message" in r && r.message).toMatch(/3/);
  });
});

describe("A1 유일성 — 프로젝트 평면이 전부 마운트돼도 크롬 주소는 겹치지 않는다", () => {
  // RED 근거(실측, 2026-07-26): 프로젝트를 전부 마운트해 세션을 유지하므로(비활성은 화면 밖
  // 파킹) 평면 안의 크롬 노드가 프로젝트마다 한 벌씩 산다. rail/left·tab/space/0·bodywrap 이
  // 각각 둘로 풀렸다 — "사이드바가 두 벌로 보인다"와 같은 축이다.
  function plane(projectId: string, active: boolean, nodes: string[]): void {
    const p = document.createElement("div");
    p.dataset.projectPlane = projectId;
    if (active) p.dataset.projectActive = "1";
    for (const n of nodes) {
      const el = document.createElement("div");
      el.setAttribute("data-node", n);
      p.appendChild(el);
    }
    document.body.appendChild(p);
  }

  it("정본 주소가 프로젝트를 싣는다", () => {
    plane("t1", true, ["rail/left"]);
    plane("t2", false, ["rail/left"]);
    const addrs = collectExposed().map((n) => n.address);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(addrs.some((a) => a.includes("/proj/t1/chrome/rail/left"))).toBe(true);
    expect(addrs.some((a) => a.includes("/proj/t2/chrome/rail/left"))).toBe(true);
  });

  it("생략형은 활성 프로젝트로 풀린다 — 문법의 '생략=활성'", () => {
    plane("t1", true, ["rail/left"]);
    plane("t2", false, ["rail/left"]);
    const r = resolveExposed("chrome/rail/left");
    expect("el" in r).toBe(true);
    if ("el" in r) {
      expect(r.el.closest("[data-project-plane]")?.getAttribute("data-project-plane")).toBe("t1");
    }
  });

  it("평면 밖 크롬(창 전역)은 프로젝트를 싣지 않는다", () => {
    const el = document.createElement("div");
    el.setAttribute("data-node", "window/empty");
    document.body.appendChild(el);
    expect(collectExposed().some((n) => n.address.endsWith("/chrome/window/empty"))).toBe(true);
  });
});
