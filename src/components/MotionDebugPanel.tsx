// 모션 관측 패널 — 개발 빌드에서만 뜬다(BuildBadge 가 DEV/DEBUG 일 때만 렌더한다).
//
// 왜 사람 손에 쥐어 주나: 이 결함들은 전부 움직이는 도중에만 존재한다 — 표면이 옛 자리에
// 좌초해 사이드바가 두 벌로 보이고, 탭 복귀에 깜빡이고, 패널이 잠깐 좁아진 채 가장자리가
// 선으로 남는다. 눈으로 그 찰나를 잡는 쪽과 좌표로 읽는 쪽이 다르므로, 멈추는 손잡이는
// 사람에게 있어야 하고 읽는 명령은 같은 순간을 봐야 한다. 설정 소유자가 하나인 이유다
// (lib/motionDebug — ui.motion 명령과 이 패널이 같은 상태를 쓴다).
//
// 멈춰 둔 채로 읽는 법: ui.snapshot.dom 이 노출 노드 전부를 그 한 순간에 잰다.
import { useEffect, useState } from "react";
import {
  motionDebugState,
  onMotionDebugChange,
  setMotionDebug,
} from "../lib/motionDebug";

const SCALES = [1, 5, 20, 50];

export function MotionDebugPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState(motionDebugState);
  useEffect(() => onMotionDebugChange(() => setState(motionDebugState())), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="motion-debug" data-node="motion-debug" role="group" aria-label="motion">
      <div className="motion-debug-row">
        <span className="motion-debug-label">배속</span>
        {SCALES.map((s) => (
          <button
            key={s}
            type="button"
            data-node={`motion-debug/scale/${s}`}
            className={state.scale === s ? "on" : undefined}
            onClick={() => setMotionDebug({ scale: s })}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="motion-debug-row">
        <button
          type="button"
          data-node="motion-debug/hold"
          className={state.hold ? "on" : undefined}
          onClick={() => setMotionDebug({ hold: !state.hold })}
        >
          {state.hold ? "재개" : "정지"}
        </button>
        <span className="motion-debug-hint">
          {state.hold ? "멈춰 있음 — 지금 DOM 을 읽어도 된다" : "느리게 돌린 뒤 정지"}
        </span>
      </div>
    </div>
  );
}
