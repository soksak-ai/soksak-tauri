// 네이티브 child 웹뷰 GC — 불변식: *이 창의* 존재하는 `b-<windowLabel>-<viewId>` 웹뷰 집합
// ⊆ 이 창 스토어의 webview 소유 뷰 집합. 생성/파괴는 브라우저 플러그인(콘텐츠 뷰)의 수명주기가
// 담당하지만, 비동기 생성과 빠른 닫기/이동이 겹치면 고아 웹뷰(아무도 못 닫는 유령 창)가 생길 수
// 있다 — 레이아웃이 바뀔 때마다(이벤트 기반, 폴링 없음) 불변식을 검증·회수한다. label 은 창
// 네임스페이스(webviewLabels 단일 진실)라 webview_list(앱 전역)를 이 창 접두사로 걸러 *자기 창*
// 것만 회수한다(다른 창 것 종료 금지). 소유 뷰 "집합"이 변한 경우에만 네이티브 질의(webview_list)
// — 드래그 등 무관한 store 쓰기는 문자열 비교 한 번으로 끝난다(docs/PERFORMANCE.md 원칙 5).
//
// child webview(native surface)를 소유하는 뷰는 코어가 이름으로 알지 않는다 — 플러그인이 매니페스트
// contributes.views[].nativeSurface=true 로 "선언"하고(spec 데이터 주도), 여기는 그 선언에서 파생한
// ownsSurface 술어로만 판정한다. 코어에 플러그인 id 하드코딩 = 강결합(플러그인/코어 분리 원칙 위반).

import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";
import { rafThrottle } from "./rafThrottle";
import { allGroups, useSessions, type Project } from "../state/sessions";
import { usePlugins } from "../state/plugins";
import { browserLabel, browserLabelPrefix } from "./webviewLabels";

// "플러그인 pluginId 의 뷰 viewId 가 native child surface 를 소유하는가" — 매니페스트 선언의 술어형.
export type OwnsSurface = (pluginId: string, viewId: string) => boolean;

// 실런타임 술어 — 로드된 플러그인 매니페스트(usePlugins)의 nativeSurface 선언에서 파생.
// 미로드/미선언 = 비소유(선언 없이 소유 없음 — declared≡actual 원칙의 GC 면).
function ownsSurfaceFromManifests(pluginId: string, viewId: string): boolean {
  const p = usePlugins.getState().plugins[pluginId];
  if (!p) return false;
  return p.manifest.contributes.views.some((v) => v.id === viewId && v.nativeSurface);
}

// 순수 — tabs 에서 webview 를 소유하는(선언한) 모든 뷰의 label 집합. ownsSurface/labelOf 주입으로
// 플러그인 상태·창 네임스페이스(currentWindowLabel)에 의존하지 않는 단위검증이 가능하다.
export function collectWebviewLabels(
  tabs: readonly Project[],
  ownsSurface: OwnsSurface,
  labelOf: (viewId: string) => string = browserLabel,
): Set<string> {
  const live = new Set<string>();
  for (const t of tabs) {
    for (const c of t.spaces) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.tabs) {
          // nativeSurface 선언 뷰 — browserLabel(view.id) 스킴으로 child webview/surface 소유.
          if (v.kind === "plugin" && ownsSurface(v.pluginId, v.view))
            live.add(labelOf(v.id));
        }
      }
    }
  }
  return live;
}

function liveBrowserLabels(): Set<string> {
  return collectWebviewLabels(useSessions.getState().projects, ownsSurfaceFromManifests);
}

// "이미 붙였다"는 기억은 갈아끼우기 경계를 넘어야 한다 — 이 플래그만 사라지면 설치는
// 안 남았는데 채우던 쪽은 이미 돌았다고 알아 다시 붙이지 않는다(영영 미설치).
/** 스윕 루프가 이미 섰는가 — 이것만 사라지면 세운 쪽은 이미 세웠다고 알아 다시 안 세운다. */
const started = moduleState("lib/webviewGc#started", () => ({ on: false }));

// 복구 리부트 가드(webview_health recovery-in-flight 1회 플래그) — 크래시한 메인 webview 의
// 복구 리로드 직후 프론트는 스토어가 빈 채로 부팅하므로, 세션 복원이 적용되기 전의 스윕은
// live=∅ 오판으로 살아있는 child b-* 를 회수할 수 있다. 코어 플래그를 1회 소모해 held 로
// 시작하고, windowBoot 가 복원 적용 후 releaseWebviewGcHold 로 해제한다. 평시 부팅은
// consume=false 로 즉시 released. (컨트롤 플레인 main 창은 windowBoot 를 돌지 않지만
// child webview 도 없어 스윕이 무의미 — held 잔존이 무해하다.)
export type GcGateState = "pending" | "held" | "released";

// 게이트 전이 순수 핵 — consume 응답 도착 시의 다음 상태. windowBoot 의 release 가 먼저
// 도착했으면(released) 뒤늦은 consume 응답이 되돌리지 못한다(단방향 해제).
export function gateAfterConsume(cur: GcGateState, inFlight: boolean): GcGateState {
  if (cur === "released") return "released";
  return inFlight ? "held" : "released";
}

// 갈아끼우기 경계 밖 — 게이트 상태와 청소 자리가 새것이 되면 "이미 열었다"는 판정이
// 사라지고, 여는 쪽은 이미 열었다고 알아 다시 열지 않는다.
/** 복구 리부트 가드 — 단방향 해제(released 는 되돌아가지 않는다). */
const gate = moduleState("lib/webviewGc#gate", () => ({
  gcGate: "pending" as GcGateState,
}));

/** 청소 자리 — 게이트와 별개로 배선된다(수명이 다르다). */
const sweepHandle = moduleState("lib/webviewGc#sweep", () => ({
  sweepRef: null as (() => void) | null,
}));

export function releaseWebviewGcHold(): void {
  const was = gate.gcGate;
  gate.gcGate = "released";
  if (was !== "released") sweepHandle.sweepRef?.();
}

export function startWebviewGc(): void {
  if (started.on) return;
  started.on = true;

  let lastKey: string | null = null;
  const sweep = rafThrottle(() => {
    // 복구 리부트 가드 — 복원 적용(release) 전 스윕 금지(위 gate.gcGate 머리말).
    if (gate.gcGate !== "released") return;
    // 매니페스트 미적재(부팅 직후·플러그인 스캔 전) 동안은 판정 불가 — live=∅ 오판으로 HMR 생존
    // webview 를 잘못 회수할 수 있다. 선언이 실릴 때까지 보류(usePlugins 구독이 적재 시 재발화).
    if (Object.keys(usePlugins.getState().plugins).length === 0) return;
    const live = liveBrowserLabels();
    const key = [...live].sort().join(",");
    if (key === lastKey) return;
    lastKey = key;
    const prefix = browserLabelPrefix();
    void invoke<string[]>("webview_list")
      .then((labels) => {
        for (const label of labels) {
          // webview_list 는 앱 전역(모든 창)의 브라우저 webview 를 반환한다 — 이 창 것(prefix)만
          // 대조·회수한다. 다른 창 브라우저는 그 창 GC 가 맡으므로 절대 건드리지 않는다(교차 종료 금지).
          if (!label.startsWith(prefix)) continue;
          if (!live.has(label)) {
            invoke("webview_close", { label }).catch(() => {});
          }
        }
      })
      .catch(() => {});
  });

  sweepHandle.sweepRef = sweep;
  useSessions.subscribe(() => sweep());
  usePlugins.subscribe(() => sweep()); // 매니페스트 적재/변경 시 재판정(부팅 보류 해제 포함)
  // 복구 리부트 여부를 코어에서 1회 소모 — 아니면 즉시 released 로 평시 스윕 재개.
  void invoke<boolean>("webview_recovery_consume")
    .then((inFlight) => {
      const next = gateAfterConsume(gate.gcGate, inFlight);
      if (gate.gcGate === next) return;
      gate.gcGate = next;
      if (next === "released") sweep();
    })
    .catch(() => {
      // 코어 조회 실패(테스트 런타임 등) — 보류를 영구화하지 않는다.
      if (gate.gcGate !== "released") {
        gate.gcGate = "released";
        sweep();
      }
    });
}
