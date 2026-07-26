// term.* 의 단일 대상 해석 경로 — 전부 PTY substrate(ptyObservationStore)로 해석한다.
// 코어는 터미널 뷰를 소유하지 않는다(터미널도 플러그인 뷰) — 따라서 term.read/send/exec/cwd 는
// app.pty 로 구동되는 플러그인 터미널에만 닿는다(코어 락인 0). 대상 키 = 그 터미널 인스턴스의
// 탭 id(registerIo(tabId)). 같은 키로 IO(읽기/쓰기)와 관찰(cwd)이 묶인다.
//
// [불변식] 탭 하나당 producer 는 하나(substrate IO). 명시 tab 이 관찰을 가지면 그 탭,
// 아니면 컨텍스트(활성 체인의 터미널 탭)를 substrate 술어로 찾는다.

import {
  getObservedCwd,
  getPtyIo,
  hasPtyObservation,
} from "../terminal/ptyObservationStore";
import type { CommandContext } from "./registry";

// 해석된 터미널 대상 — 탭 id + substrate IO.
export interface TermTarget {
  tabId: string;
  /** 화면+스크롤백 텍스트(끝에서 lines 줄). 준비 안 됐으면 undefined. */
  readBuffer: (lines?: number) => string | undefined;
  /** PTY 에 raw 입력 주입. 준비 안 됐으면 false. */
  sendInput: (data: string) => boolean;
  /** 현재 작업 디렉토리(셸 통합 OSC). 미확인이면 undefined. */
  getCwd: () => string | undefined;
}

// 컨텍스트(활성 체인) 기반 터미널 탭 해석기 — 명시 tab 이 없을 때 쓴다. catalog 가
// sessions+substrate 술어로 구현해 주입한다(순환 import 회피). null 이면 컨텍스트에 터미널 없음.
export type ContextResolve = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => { tabId: string } | null;

// substrate(플러그인 터미널 등 app.pty 구동) IO 로 하는 대상.
function substrateTarget(tabId: string): TermTarget {
  return {
    tabId,
    readBuffer: (lines) => getPtyIo(tabId)?.readBuffer(lines),
    sendInput: (data) => {
      const io = getPtyIo(tabId);
      if (!io) return false;
      io.sendInput(data);
      return true;
    },
    getCwd: () => getObservedCwd(tabId),
  };
}

/**
 * term.* 의 대상 탭을 단일 경로로 해석한다(전부 substrate).
 *   1) 명시 tab 이 substrate 관찰을 가지면(hasPtyObservation) 그 탭.
 *   2) 명시 tab 이 없으면 contextResolve(활성 체인의 터미널 탭)로 찾는다.
 * 둘 다 아니면 null(→ 호출처가 TARGET_NOT_FOUND).
 *
 * contextResolve 생략(단위 테스트 등) 시 명시 tab 경로만 시도한다.
 */
export function resolveTermTab(
  params: Record<string, unknown>,
  ctx: CommandContext,
  contextResolve?: ContextResolve,
): TermTarget | null {
  const explicit = params.tab as string | undefined;
  if (explicit) {
    return hasPtyObservation(explicit) ? substrateTarget(explicit) : null;
  }
  const ctxTab = contextResolve?.(params, ctx);
  if (ctxTab && hasPtyObservation(ctxTab.tabId)) {
    return substrateTarget(ctxTab.tabId);
  }
  return null;
}
