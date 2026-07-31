// 활동 피드 공급자(A1) — 이 창의 실행 사실을 코어 허브(activity.rs)로 발행한다.
// 계열 ①: 플러그인 이벤트(command.started/finished·turn.ended·view.activated) — 터미널·AI 턴.
// 계열 ②: 커맨드 레지스트리 execute 계측(CommandTrace) — 오케스트레이터가 내리는 모든 명령.
// 허브가 seq/ts 를 부여하고 전 창 브로드캐스트+영속하므로 여기선 발행만 한다.

import { ledgerOf, notePublish, stampOf } from "./activityHealth";
import { invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { onPluginEvent } from "../plugins/hooks";
import { setCommandTraceSink } from "../commands/commandObservation";
import { tmsg } from "../i18n";

/** 허브 발행(창 label 자동 동반) — 코어 공급자 공용(이 파일의 계측 + orchestrator 대화 세트). */
export function publishActivity(
  kind: string,
  source: string,
  payload: Record<string, unknown>,
): void {
  void invoke("activity_publish", {
    kind,
    source,
    payload: { ...payload, window: currentWindowLabel() },
  })
    .then((reply) => {
      // 도장이 있어야 적재다 — 호출이 resolve 한 것만으로는 원장에 남았다고 말할 수 없다.
      const seq = stampOf(reply);
      if (seq === null) {
        notePublish(
          false,
          Date.now(),
          "적재 도장 없음 — 발행은 갔는데 원장에 안 남았다(응답에 seq 부재)",
        );
        return;
      }
      notePublish(true, Date.now(), undefined, seq, ledgerOf(reply));
    })
    .catch((e: unknown) => {
      // 허브 불능(테스트 하니스 등)은 라이브 동작을 막지 않는다 — 그러나 **센다**. 막지 않는
      // 것과 사실을 안 남기는 것은 다르다: 삼킨 실패는 발행이 통째로 끊겨도 조용해서, 밖에서는
      // 원장을 두 번 조회해 시각을 비교해야 알 수 있었다(실측 2026-07-31).
      notePublish(false, Date.now(), e instanceof Error ? e.message : String(e));
    });
}
const publish = publishActivity;

/** 부트 1회 — 이벤트 구독과 registry 계측 sink 를 허브로 잇는다. */
export function startActivityFeed(): void {
  // 산출자가 자기 표시 문장(message)·낭독(speak)을 소유한다(명령이 그러듯 — 소비자는 kind 무지).
  // 터미널 명령 활동은 터미널 플러그인이 소유한다(자기 i18n 으로 app.activity.publish) — 코어는
  // command.started/finished 를 브리지하지 않는다. 여기 남는 건 코어 도메인(턴 감지·뷰 관리·generic
  // 진행 릴레이·registry 계측)뿐이고, 그 문장은 코어 i18n(activity.*)에 산다.
  onPluginEvent("turn.ended", (p) => {
    const agentKind = (p as { agentKind?: string | null }).agentKind;
    publish("turn.ended", p.source, {
      paneId: p.paneId,
      command: p.command,
      agentKind,
      sessionId: (p as { sessionId?: string | null }).sessionId,
      message:
        tmsg("activity.turn.ended") +
        (agentKind ? ` (${agentKind})` : "") +
        (p.command ? ` — ${p.command}` : ""),
    });
  });
  onPluginEvent("view.activated", (p) =>
    publish("view.activated", "ui", {
      projectId: p.projectId,
      viewId: p.viewId,
      message: tmsg("activity.view.activated", { viewId: p.viewId }),
    }),
  );
  // 진행 델타(요청→응답 사이) — 사이드카 이벤트·AI thinking 을 소비 플러그인이 command.progress
  // 로 발행하면 활동 스트림에 얹는다(MESSAGE-PROTOCOL.md §2). textdelta 개념.
  onPluginEvent("command.progress", (p) => {
    const command = (p as { command?: string }).command;
    const delta = (p as { delta?: unknown }).delta;
    publish("command.progress", (p as { source?: string }).source ?? "plugin", {
      command,
      delta,
      message: `⋯ ${command ? `${command}: ` : ""}${delta ?? ""}`,
    });
  });
  // 레지스트리 계측(P12 본체) — params 는 키 목록만 도착한다(registry 가 요약).
  // 계측 제외는 spec.trace === false 선언이 담당한다(registry 가 sink 호출 자체를 건너뜀).
  setCommandTraceSink((t) => {
    publish("command.executed", t.source, {
      command: t.command,
      title: t.title,
      danger: t.danger,
      paramKeys: t.paramKeys,
      ok: t.ok,
      code: t.code,
      message: t.message,
      durationMs: t.durationMs,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      media: t.media,
      speak: t.speak,
      parentId: t.parentId,
      origin: t.origin,
    });
  });
}
