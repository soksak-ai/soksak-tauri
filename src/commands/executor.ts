// 명령 실행기: Rust 소켓 서버가 emit 한 cmd-request 를 registry 로 실행하고
// invoke(cmd_result) 로 회신한다(요청 id 매칭). 앱 시작 시 1회 startExecutor().

import { invoke as frameworkInvoke } from "../framework";
import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { listenThisWindow } from "../lib/windowEvents";
import { useSettings } from "../state/settings";
import { registerCatalog } from "./catalog";
import { registerDebugCatalog } from "./catalogDebug";
import { registerOrchestratorCatalog } from "./catalogOrchestrator";
import { registerRemoteCatalog } from "./catalogRemote";
import { registerRemoteConfirmDevCatalog } from "./catalogRemoteConfirmDev";
import { getSpec, execute, setPermissionGate } from "./registry";
import { markRuntimeReady } from "./commandObservation";
import { completeCommandReply } from "./commandReplyTransaction";
import type { CommandAfterReplyTask } from "./registry";

interface CmdRequest {
  id: number;
  method: string;
  params?: Record<string, unknown> | null;
  pane?: string | null;
  window?: string | null;
  // 상관 부모(대화 턴 id) — 에이전트 env SOKSAK_PARENT → sok → 소켓 요청 meta. ctx 로 관통해
  // 활동 엔트리 payload.parentId 가 된다(턴 세트 묶음).
  parent?: string | null;
  // 실행 유래(§5) — Rust 내부 발화(스케줄러 "schedule")만 싣는다. 시스템 유래는 무낭독·흐림.
  origin?: string | null;
  // 이 요청을 몇이 함께 수행하는가 — 같은 라벨을 두 프레임워크가 들면 둘 다에게 온다.
  hosts?: number | null;
}

// "이미 채웠다"는 기억은 등록부와 **함께** 살아야 한다. 한쪽만 갈리면 둘이 어긋난다:
// 등록부만 갈리면 영영 빈 채로 남고(코어 명령 소실), 기억만 갈리면 중복 등록으로 죽는다.
const boot = moduleState("commands/executor#boot", () => ({ started: false }));

// 부팅 준비 게이트 — 플러그인 활성화(initPluginHost) 완료 전에 도착한 외부 요청(스케줄러·소켓)을
// 완료 이벤트까지 지연한다. 부팅 직후 발화가 아직 등록 전인 플러그인 명령(또는 등록은 됐지만
// 의존 플러그인이 활성화 전인 핸들러)에 부딪혀 가짜 UNKNOWN_COMMAND 를 내던 레이스의 구조적
// 봉합(재시도·폴링 없음). "미등록 명령만 대기"는 부족하다 — 등록된 명령의 핸들러가 다른
// 플러그인 명령을 부르는 경우(workflow reconcile → kanban)를 놓친다. 전부 대기가 올바른 의미론.
// 갈아끼우기 경계 밖 — 이 값들이 새것이 되면 "이미 했다"는 기억과 지연 초기화·구독
// 해지 자리가 함께 사라지고, 채우던 쪽은 다시 채우지 않는다.
const ms = moduleState("commands/executor#state", () => ({
  hostReady: false,
  resolveFrameworkReady: undefined as (() => void) | undefined,
}));
const hostReadyGate = new Promise<void>((resolve) => {
  ms.resolveFrameworkReady = resolve;
});

/** 플러그인 호스트 활성화 완료 신호 — main.tsx 가 initPluginHost() 직후 1회 호출한다. */
export function markCommandHostReady(): void {
  ms.hostReady = true;
  // 배선 완료 선언 — 이 뒤로 빠진 관측 배선은 "아직"이 아니라 결함이고, 응답이 그것을 말한다.
  markRuntimeReady();
  ms.resolveFrameworkReady?.();
}

/**
 * 플러그인 부팅이 끝났는지 **밖에서** 기다린다.
 *
 * 워크스페이스 부팅 위상이 준비라고 답해도 플러그인 본문은 아직 돈다 — 두 사실은 다른 것이고,
 * 다른 것을 같은 이름으로 물으면 그 뒤에 찍히는 도장을 못 보고 "잰 적 없음" 이 된다(실측
 * 2026-08-08). 되묻지 않는다: 이미 지난 사실이면 즉시, 아니면 그 사건에 걸린다.
 *
 * 상한을 넘기면 거절한다. 못 기다린 것을 "준비됐다" 로 답하면 부르는 쪽이 없는 사실 위에서
 * 판정한다.
 */
export function awaitCommandHostReady(timeoutMs: number): Promise<{ ready: true }> {
  if (ms.hostReady) return Promise.resolve({ ready: true as const });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`플러그인 부팅이 ${timeoutMs}ms 안에 끝나지 않았습니다`)),
      timeoutMs,
    );
    void hostReadyGate.then(() => {
      clearTimeout(timer);
      resolve({ ready: true as const });
    });
  });
}

export function startExecutor(): void {
  if (boot.started) return;
  // 명령 수신이 열리기까지 실측 10 초가 걸렸는데 그 구간을 재는 자리가 없었다(2026-08-08).
  // 카탈로그 등록과 리스너 설치 사이가 어디서 갈리는지 기계가 답한다.
  const executorAt = performance.now();
  const executorStep = (name: string) => {
    // 웹뷰 콘솔은 소켓으로 못 읽는다 — 활동 원장에 실어야 기계가 답한다(boot.step 과 같은 축).
    void frameworkInvoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: {
        step: `executor:${name}`,
        message: `· executor ${name} +${(performance.now() - executorAt).toFixed(0)}ms`,
      },
    }).catch(() => {});
  };
  boot.started = true;
  registerCatalog();
  // 원격 confirm 데스크톱 사람 게이트(remote.confirm) — remote-iroh 사이드카가 destructive 결정을
  // 위임하는 라이브 커맨드. 권위(PendingConfirms·토큰)는 사이드카, 사람 결정만 코어 모달에서.
  registerRemoteCatalog();
  // dev 전용 mock 커맨드(프로덕션 번들엔 등록 0) — 라이브 폰 없이 confirm 모달 헤드리스 검증.
  registerRemoteConfirmDevCatalog();
  // dev 전용 debug.* — 스케줄러 process_lease lease e2e 검증용 held-reply(debug.sleep). 프로덕션 0.
  registerDebugCatalog();
  // 자연어 콘솔(orchestrator.*)은 컨트롤 플레인(main) 전용 — 워크스페이스 창엔 존재하지 않는
  // capability 다(UNKNOWN_COMMAND 가 정답). 소켓은 --window main 으로 명시 타겟.
  if (currentWindowLabel() === "main") registerOrchestratorCatalog();
  // 권한 게이트: 위험 분류별 정책을 설정 store 에서 읽어 allow/deny 판정.
  setPermissionGate((danger) => {
    const s = useSettings.getState();
    const policy =
      danger === "destructive" ? s.remoteDestructive : s.remoteInject;
    if (policy === "deny") {
      console.warn(`[권한] 원격 ${danger} 명령 차단(정책: deny)`);
      return false;
    }
    return true;
  });
  // 이 창에 emit_to 된 cmd-request 만 받는다(전역 listen 이면 emit_to(다른 창) 도 받아 명령이
  // 두 창에서 중복 실행 → 창별 독립 붕괴). lib/windowEvents 머리말 참조.
  executorStep("catalog-registered");
  // 한 요청은 한 번만 실행한다 — 리스너 설치와 밀린 배달 회수 사이에 온 것은 두 경로로 올 수
  // 있다. 배달 쪽은 무엇이 이미 실행됐는지 모르므로 여기가 유일한 판정 자리다(부수효과는
  // 두 번 일어나면 되돌릴 수 없다).
  const served = new Set<number>();
  const subscription = listenThisWindow<CmdRequest>("cmd-request", async (e) => {
    const { id, method, params, pane, window, parent, origin, hosts } = e.payload;
    if (served.has(id)) return;
    served.add(id);
    // 호스트 미준비 = 플러그인 활성화 진행 중. 게이트는 **미등록 명령만** 세운다 — 이미
    // 등록된 코어 명령(state.tree 등)까지 잡으면 복원은 231ms 에 끝났는데 소켓 응답이
    // 플러그인 활성화(실측 2.5s) 뒤로 밀린다(복원 300ms 기준의 마지막 병목이 이 게이트였다).
    // 미등록 명령은 완료까지 대기 — 그 뒤에도 미등록이면 그때의 UNKNOWN_COMMAND 가 진짜다.
    if (!ms.hostReady && getSpec(method) === undefined) await hostReadyGate;
    // 소켓 경유 = 원격(AI/CLI) 호출 → 권한 게이트 적용 대상. window 는 자기 창 label
    // (라우팅 확인·명령 컨텍스트용).
    const afterReply: CommandAfterReplyTask[] = [];
    const result = await execute(method, params ?? {}, {
      pane: pane ?? undefined,
      remote: true,
      window: window ? { label: window } : undefined,
      parent: parent ?? undefined,
      origin: origin ?? undefined,
      hosts: hosts ?? undefined,
      afterReply: (task) => afterReply.push(task),
    });
    await completeCommandReply(
      () => invoke("cmd_result", { id, result }),
      afterReply,
      (err) => console.error("cmd_result 회신 실패:", err),
    );
  });
  // 리스너가 서기 전에 온 배달을 회수한다. `emit_to` 는 창이 있으면 성공하므로 그 사건은
  // 조용히 사라지고, 보낸 쪽은 답 상한(10s)까지 기다린다 — 실측 2026-08-08: 부팅 11.7 초 중
  // 9.4 초가 첫 명령 한 건의 상한이었다.
  //
  // **정말 듣기 시작한 뒤에** 알린다. 등록을 시작한 직후에 알리면 회수한 봉투도 아직 없는
  // 리스너에게 가서 똑같이 사라진다(실측: 회수 1건, 그래도 그 명령은 10.002 초에 TIMEOUT).
  void subscription.ready.then(async () => {
    executorStep("listener-installed");
    const resent = await frameworkInvoke<number>("cmd_listener_ready", {
      window: currentWindowLabel(),
    }).catch((err) => `실패:${String(err)}`);
    executorStep(`pending-drained:${resent}`);
  });
}
