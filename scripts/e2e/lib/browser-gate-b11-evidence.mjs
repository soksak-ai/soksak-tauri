import {
  B11_PANE_STAGES,
  B11_PANE_STAGE_KEYS,
  B11_WHEEL_LEDGER_KEYS,
  B11_WHEEL_LEDGER_STAGES,
} from "./browser-gate-b11.mjs";
import { mapWithWiring } from "./browser-machine-judge-support.mjs";
import { mapPageState } from "./browser-page-state.mjs";

/** 못 읽은 축은 null로 남긴다 — 0으로 채우면 실패가 성공값으로 둔갑한다. */
const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function mapKeys(raw, keys) {
  const mapped = {};
  for (const key of keys) mapped[key] = numberOrNull(raw?.[key]);
  return mapped;
}

function mapWheelLedger(ledger) {
  const mapped = {};
  for (const stage of B11_WHEEL_LEDGER_STAGES) {
    mapped[stage] = mapKeys(ledger?.[stage], B11_WHEEL_LEDGER_KEYS);
  }
  return mapped;
}

function mapPaneStages(stages) {
  const mapped = {};
  for (const name of B11_PANE_STAGES) mapped[name] = mapKeys(stages?.[name], B11_PANE_STAGE_KEYS);
  return mapped;
}

/**
 * B11의 세 축을 판정 봉투로 옮긴다. 축 목록은 판정이 소유하고 여기서는 옮기기만 한다 —
 * 손으로 다시 나열하면 반드시 하나가 빠진다. 요청값(requestedDy·requestedDx)은 요청으로,
 * 관측값(positions·stages)은 관측으로 남기고 서로 베끼지 않는다.
 *
 * 하니스가 탭마다 짓는 인계 기록의 필드는 배선 장부를 통해 읽는다. 그 안쪽 영수증(scroll·
 * fullCapture·paneResize)은 사람 검토용 표시처럼 기계 판정이 쓰지 않는 필드도 싣는다.
 * 소비보다 넓은 기록에 장부를 걸지 않는다 — 남는 필드는 어긋남이 아니다.
 */
export function mapB11TabEvidence(raw = {}) {
  return mapWithWiring(raw, "B11.tab", (checkpoint) => {
    const viewId = checkpoint.take("viewId") ?? null;
    const scroll = checkpoint.take("scroll");
    const fullCapture = checkpoint.take("fullCapture");
    const paneResize = checkpoint.take("paneResize");
    return {
      viewId,
      wheel: {
        positions: [scroll?.beforeY ?? null, scroll?.afterY ?? null, scroll?.restoredY ?? null],
        requestedDy: [
          numberOrNull(scroll?.requestedDy?.[0]),
          numberOrNull(scroll?.requestedDy?.[1]),
        ],
        ledger: mapWheelLedger(scroll?.ledger),
        settledAtUnixMs: numberOrNull(scroll?.settledAtUnixMs),
      },
      capture: {
        before: mapPageState(fullCapture?.before),
        receipt: {
          requestedViewId: viewId,
          returnedViewId: fullCapture?.viewId ?? null,
          requestedPath: fullCapture?.requestedPath ?? null,
          returnedPath: fullCapture?.returnedPath ?? null,
          reportedBytes: fullCapture?.reportedBytes ?? null,
          fileBytes: fullCapture?.fileBytes ?? null,
          width: fullCapture?.width ?? null,
          docHeight: fullCapture?.height ?? null,
          capturedWidth: numberOrNull(fullCapture?.capturedWidth),
          capturedHeight: numberOrNull(fullCapture?.capturedHeight),
        },
        after: mapPageState(fullCapture?.after),
      },
      paneResize: {
        paneId: paneResize?.paneId ?? null,
        side: paneResize?.side ?? null,
        requestedDx: numberOrNull(paneResize?.requestedDx),
        stages: mapPaneStages(paneResize?.stages),
      },
    };
  });
}
