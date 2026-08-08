// 표면 입력의 **주인** — 그 표면을 만든 쪽이 그 표면의 포인터를 배달한다.
//
// 코어가 쥔 표면(프레임워크 자식 웹뷰)에만 포인터가 들어갔다. 플러그인이 엔진 사이드카로 그리는
// 표면은 코어의 통로가 닿지 않아 "webview 없음" 으로 거절됐다 — 실측 2026-08-08: 브라우저 세 종
// 중 하나만 게스처가 됐고 둘은 이름만 다른 거절을 받았다.
//
// 코어가 그 엔진을 알아서는 안 된다. 아는 쪽은 그 표면을 만든 플러그인이고, 코어가 할 일은
// **누가 주인인지 묻는 자리**를 두는 것뿐이다. 주인이 있으면 그리로, 없으면 프레임워크로.
import { moduleState } from "./moduleState";
import type { SurfacePointerInput } from "./contentViews";

/** 한 표면에 포인터를 넣고 그 상태를 답하는 쪽 — 계약은 프레임워크 어댑터와 같은 모양이다. */
export interface SurfaceInputProvider {
  /**
   * 이 라벨이 내 것인가.
   *
   * 라벨 문법으로 코어가 추측하지 않는다 — 접두사로 가르면 그 문법이 바뀌는 날 남의 표면으로
   * 배달된다. 주인이 스스로 답한다.
   */
  owns(label: string): boolean;
  sendInput(label: string, input: SurfacePointerInput): Promise<void>;
  inputState(label: string, at?: { x: number; y: number }): Promise<Record<string, unknown>>;
}

/** 등록부는 갈아끼우기 경계 밖이다 — 모듈이 새것이 되어도 걸어 둔 주인은 남아야 한다. */
const state = moduleState("lib/surfaceInputProviders#registry", () => ({
  byOwner: new Map<string, SurfaceInputProvider>(),
}));

/**
 * 이 플러그인이 자기 표면의 입력을 배달한다고 건다. 반환은 해지 — 뷰가 사라지면 주인도
 * 사라진다(남기면 죽은 사이드카로 계속 보낸다).
 *
 * 같은 주인이 다시 걸면 갈아끼운다. 두 벌이 되면 아래 중복 판정이 자기 자신과 충돌한다.
 */
export function registerSurfaceInputProvider(
  owner: string,
  provider: SurfaceInputProvider,
): () => void {
  state.byOwner.set(owner, provider);
  return () => {
    if (state.byOwner.get(owner) === provider) state.byOwner.delete(owner);
  };
}

/**
 * 이 표면의 주인. 없으면 `null` — 그 자리는 프레임워크가 맡는다.
 *
 * 둘이 자기 것이라 하면 던진다. 하나를 골라 주면 배달이 어디로 가는지 값으로 알 수 없고,
 * 그 모호함은 조용히 오래 산다.
 */
export function surfaceInputProvider(label: string): SurfaceInputProvider | null {
  const claimed: string[] = [];
  let found: SurfaceInputProvider | null = null;
  for (const [owner, provider] of state.byOwner) {
    let owns: boolean;
    try {
      owns = provider.owns(label);
    } catch (error) {
      // 판단이 죽은 것을 삼키면 배달이 조용히 프레임워크로 샌다.
      throw new Error(
        `표면 주인 판단이 실패했습니다(${owner}, ${label}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!owns) continue;
    claimed.push(owner);
    found = provider;
  }
  if (claimed.length > 1) {
    throw new Error(`두 주인이 같은 표면을 주장합니다(${label}): ${claimed.join(", ")}`);
  }
  return found;
}

/** 지금 걸린 주인들 — 관측면(누가 무엇을 맡았는지 셀 수 없으면 "아무도 안 맡았다"가 안 보인다). */
export function surfaceInputOwners(): string[] {
  return [...state.byOwner.keys()].sort();
}

/** 테스트 전용 초기화 — 등록부는 갈아끼우기 경계 밖이라 모듈 재평가로는 안 비워진다. */
export function __resetSurfaceInputProvidersForTest(): void {
  state.byOwner.clear();
}
