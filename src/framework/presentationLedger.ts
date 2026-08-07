// 표시 프레임 원장 — **어느 view 가 어느 표시 epoch 에 어떤 자리로 보였는가.**
//
// 이 축은 프레임워크의 것이 아니다. 판정이 묻는 것은 "그 순간 화면에 무엇이 있었는가" 하나이고,
// 그 답을 만드는 물건만 프레임워크마다 다르다: 어떤 프레임워크는 OS 표시 콜백(display link)이
// 자기 레이어 frame 을 들고 오고, 어떤 프레임워크는 문서 자신의 프레임 콜백이 DOM 자식의
// rect 를 들고 온다. **둘 다 자기 합성기가 실제로 낸 사건이다** — 타이머도 폴링도 아니다.
//
// 그래서 코어에 서는 것은 이름 하나와 모양 하나다. 이름에 프레임워크가 없고, 모양은 어느
// 어댑터가 채웠는지 묻지 않는다. 안 걸리면 이 명령은 **없다** — 빈 원장을 답하면 부른 쪽은
// 0 프레임을 "표시가 없었다"로 읽고, 그것은 재지 않은 것을 쟀다고 말하는 것이다.
import { moduleState } from "../lib/moduleState";
import { register } from "../commands/registry";
import {
  auditPresentationReceipt,
  type PresentationLedgerAudit,
} from "./presentationLedgerAudit";

export interface PresentationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 한 view 의 표시 소유 삼인 — **부르는 쪽이 선언하고 어댑터는 대조만 한다.**
 *
 * 어댑터가 라벨 규칙이나 DOM 경로에서 view 를 복원하면 그 규칙이 곧 계약이 되고, 규칙이
 * 바뀌는 날 원장은 엉뚱한 owner 의 frame 을 그 view 의 것이라고 답한다.
 */
export interface PresentationOwner {
  /** 공개 view identity. */
  viewId: string;
  /** 이 표면을 자리에 놓는 주체 — 표면 자신과 다른 identity 다. */
  hostId: string;
  /** 표면 자신의 identity. */
  surfaceId: string;
}

/** 지금 표시 원장을 걸 수 있는 owner 전부 — 부르는 쪽이 binding 을 declare 하기 전에 읽는다. */
export interface PresentationOwnerInventoryEntry extends PresentationOwner {
  window: string;
  /** 워크스페이스 배치 pane. 아직 어느 pane 에도 안 붙었으면 null 이다. */
  logicalPaneId: string | null;
  /** 이 view 의 크롬을 그리는 renderer identity. */
  rendererId: string;
}

/** 한 표시 epoch 에서 읽은 표면 하나의 사실. */
export interface PresentationSurfaceFrame {
  viewId: string;
  surfaceId: string;
  /** 이 표면 실체의 세대. 실체가 갈리면 증가한다 — 같은 이름의 다른 물건을 구분하는 축이다. */
  generation: number;
  live: boolean;
  visible: boolean;
  painted: boolean;
  /** 공개 슬롯이 선언한 자리. */
  domFrame: PresentationRect;
  /** 표면이 실제로 놓인 자리. */
  surfaceFrame: PresentationRect;
}

/** 합성기가 실제로 낸 표시 사건 하나. 보간·타이머·추정이 이 목록에 들어올 수 없다. */
export interface PresentationDisplayEvent {
  sequence: number;
  /** 이 원장을 낸 관측 세대. 한 trace 안에서는 변하지 않는다. */
  sourceGeneration: number;
  presentationRevision: number;
  /** 이 프레임이 실제로 표시된 epoch. */
  displayTimestampUnixMs: number;
  /** 다음 표시 epoch — displayTimestamp + 표시 주기. */
  targetTimestampUnixMs: number;
  /** 우리 콜백이 그 사건을 관측한 epoch. 표시 epoch 와 다른 사실이다. */
  callbackObservedAtUnixMs: number;
  /** 이 디스플레이의 표시 주기. 재지 못하면 원장을 열지 않는다 — 0 은 답이 아니다. */
  refreshIntervalMs: number;
  presentedAtUnixMs: number;
  surfaces: PresentationSurfaceFrame[];
}

/**
 * 원장이 스스로 세는 위반. 전부 0 이어야 그 구간의 표시가 온전하다.
 *
 * - replacements: baseline 과 표면 identity(surfaceId·generation)가 달라진 프레임
 * - gaps: 직전 기록 프레임과 표시 주기 하나보다 멀리 떨어진 프레임(합성기가 건너뛴 표시)
 * - disappearances: 살아 있지 않거나 보이지 않는 표면이 섞인 프레임
 * - unpresented: 아직 아무것도 그리지 않은 표면이 섞인 프레임
 * - droppedEvents: 용량·역행으로 원장에 싣지 못한 표시 사건
 */
export interface PresentationViolations {
  replacements: number;
  gaps: number;
  disappearances: number;
  unpresented: number;
  droppedEvents: number;
}

/** 관측 자신의 품질 — 표시가 아니라 우리가 그것을 얼마나 놓쳤는가. */
export interface PresentationObservation {
  callbackIntervalsSkipped: number;
  maxCallbackLatencyMs: number;
}

export interface PresentationTraceArmed {
  traceId: string;
  /**
   * 이 원장의 `...UnixMs` 시각을 낸 시계의 이름.
   *
   * 같은 접미사가 같은 시계를 뜻하지 않는다. 이 원장의 시각을 다른 producer 의 시각과 한 축에서
   * 비교하려면 둘 다 같은 이름을 답해야 하고, 선언 없는 시계는 판정 입력이 될 수 없다.
   */
  clock: string;
  ownerViewIds: string[];
  armedAtUnixMs: number;
  baselineFrameSequence: number;
  sourceGeneration: number;
}

export interface PresentationTraceReceipt {
  traceId: string;
  /** 이 원장의 `...UnixMs` 시각을 낸 시계의 이름. `PresentationTraceArmed.clock` 과 같다. */
  clock: string;
  closed: boolean;
  ownerViewIds: string[];
  armedAtUnixMs: number;
  baselineFrameSequence: number;
  presentationEvents: PresentationDisplayEvent[];
  violations: PresentationViolations;
  observation: PresentationObservation;
}

/**
 * 회수한 원장 + **그 원장이 자기 사건과 일관되는가.**
 *
 * 위반 수는 생산자만 안다. 그래서 한 어댑터가 한 축을 아예 안 세면 그 축은 영원히 0 으로
 * 답하고, 그 0 은 "그런 일이 없었다"와 구분되지 않는다. 감사는 어느 어댑터가 답했는지 묻지
 * 않고 영수증 자신만 읽는다 — 그래서 이 자리가 감사의 집이다.
 */
export interface PresentationTraceAuditedReceipt extends PresentationTraceReceipt {
  selfAudit: PresentationLedgerAudit;
}

export interface PresentationLedgerArmInput {
  traceId: string;
  owners: readonly PresentationOwner[];
  /** 유한 용량. 넘치는 사건은 버리지 않고 droppedEvents 로 센다. */
  maxEvents?: number;
}

/**
 * 프레임워크가 채우는 구현. 세 동사뿐이다 — 누가 있는가, 무장, 그리고 닫아서 원장 회수.
 *
 * arm 은 **첫 실제 표시 사건 뒤에** 완료한다. 무장 즉시 돌아오면 그 다음 자극이 첫 프레임보다
 * 먼저 들어갈 수 있고, 그러면 baseline 이 자극 이후의 프레임이 된다.
 */
export interface PresentationLedgerHost {
  owners(): Promise<PresentationOwnerInventoryEntry[]>;
  arm(input: PresentationLedgerArmInput): Promise<PresentationTraceArmed>;
  close(input: { traceId: string }): Promise<PresentationTraceReceipt>;
}

export const PRESENTATION_LEDGER_MIN_EVENTS = 2;
export const PRESENTATION_LEDGER_MAX_EVENTS = 4096;
export const PRESENTATION_LEDGER_DEFAULT_EVENTS = 256;

const registered = moduleState("framework/presentationLedger#registered", () => ({
  host: null as PresentationLedgerHost | null,
  commandsInstalled: false,
}));

/**
 * 부르는 쪽이 선언한 owner binding 을 계약 모양으로 확정한다.
 *
 * 두 어댑터가 각자 거절하면 같은 잘못된 호출이 프레임워크마다 다른 이유로 죽는다 — 거절은
 * 이름으로 하고, 그 이름은 한 자리에서 나온다.
 */
export function parsePresentationOwners(value: unknown): PresentationOwner[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("presentation owner 목록이 비었습니다");
  }
  const owners: PresentationOwner[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const owner = raw as Partial<PresentationOwner> | null;
    const viewId = typeof owner?.viewId === "string" ? owner.viewId.trim() : "";
    const hostId = typeof owner?.hostId === "string" ? owner.hostId.trim() : "";
    const surfaceId = typeof owner?.surfaceId === "string" ? owner.surfaceId.trim() : "";
    if (!viewId || !hostId || !surfaceId) {
      throw new Error("presentation owner identity(viewId·hostId·surfaceId)가 비었습니다");
    }
    if (seen.has(viewId)) throw new Error(`presentation owner viewId 가 중복입니다: ${viewId}`);
    seen.add(viewId);
    owners.push({ viewId, hostId, surfaceId });
  }
  return owners;
}

/** 유한 용량 — 범위 밖은 이름을 달고 거절한다. 조용히 죄면 원장이 말없이 짧아진다. */
export function parsePresentationMaxEvents(value: unknown): number {
  if (value === undefined || value === null) return PRESENTATION_LEDGER_DEFAULT_EVENTS;
  const maxEvents = Number(value);
  if (!Number.isInteger(maxEvents)
      || maxEvents < PRESENTATION_LEDGER_MIN_EVENTS
      || maxEvents > PRESENTATION_LEDGER_MAX_EVENTS) {
    throw new Error(
      `presentation maxEvents 는 ${PRESENTATION_LEDGER_MIN_EVENTS}..${PRESENTATION_LEDGER_MAX_EVENTS} 정수여야 합니다: ${String(value)}`,
    );
  }
  return maxEvents;
}

function host(): PresentationLedgerHost {
  if (!registered.host) {
    throw new Error(
      "표시 원장 구현이 걸려 있지 않습니다(framework/<name>/install 이 걸어야 합니다)",
    );
  }
  return registered.host;
}

function installCommands(): void {
  if (registered.commandsInstalled) return;
  registered.commandsInstalled = true;
  register("view.presentation.owners", {
    description:
      "List every view whose surface can carry a presentation trace right now, with its window, workspace pane, chrome renderer, placing host, and surface identity. Read this before arming a trace: the caller declares the owner binding, and no adapter recovers a view identity from a label convention or DOM path.",
    params: {},
    returns: "{ count, owners:[{viewId,window,logicalPaneId,rendererId,hostId,surfaceId}] }",
    message: (data) => `표시 원장 owner ${String(data.count)}개`,
    handler: async () => {
      const owners = await host().owners();
      return { count: owners.length, owners };
    },
  });
  register("view.presentation.trace.arm", {
    description:
      "Arm one finite presentation trace over declared view surfaces and return only after the first real display event. Every recorded frame comes from the compositor's own display callback — never a timer, poll, or interpolation. The receipt names the clock its `...UnixMs` stamps came from; never compare them against another producer's stamps unless both name the same clock.",
    params: {
      traceId: { type: "string", description: "caller-owned finite trace identity", required: true },
      owners: {
        type: "json",
        description: "array of {viewId,hostId,surfaceId} owner bindings",
        required: true,
      },
      maxEvents: {
        type: "number",
        description: `finite event capacity (${PRESENTATION_LEDGER_MIN_EVENTS}..${PRESENTATION_LEDGER_MAX_EVENTS}, default ${PRESENTATION_LEDGER_DEFAULT_EVENTS})`,
      },
    },
    returns: "{ traceId,clock,ownerViewIds,armedAtUnixMs,baselineFrameSequence,sourceGeneration }",
    message: (data) => `표시 원장 ${String(data.traceId)}를 무장했습니다`,
    handler: async (params) => host().arm({
      traceId: String(params.traceId ?? ""),
      owners: parsePresentationOwners(params.owners),
      maxEvents: parsePresentationMaxEvents(params.maxEvents),
    }),
  });
  register("view.presentation.trace.close", {
    description:
      "Close one armed presentation trace, stop its display observation, and return the immutable display-event ledger with its own violation and observation counts.",
    params: {
      traceId: { type: "string", description: "trace identity returned by arm", required: true },
    },
    returns:
      "{ traceId,clock,closed,ownerViewIds,armedAtUnixMs,baselineFrameSequence,presentationEvents,violations,observation,selfAudit }",
    message: (data) => `표시 원장 ${String(data.traceId)}를 닫았습니다`,
    handler: async (params): Promise<PresentationTraceAuditedReceipt> => {
      const receipt = await host().close({ traceId: String(params.traceId ?? "") });
      // 감사를 부르지 않으면 감사는 없다. 영수증에 실어야 부르는 쪽이 안 물어도 사실이 간다.
      return { ...receipt, selfAudit: auditPresentationReceipt(receipt) };
    },
  });
}

/** 프레임워크가 자기 구현을 건다. 거는 그 순간에만 명령 표면이 선다. */
export function registerPresentationLedgerHost(implementation: PresentationLedgerHost): void {
  registered.host = implementation;
  installCommands();
}

/** 걸렸는가 — 감사가 "없음"과 "비어 있음"을 가르는 자리. */
export function hasPresentationLedgerHost(): boolean {
  return registered.host !== null;
}

export function __resetPresentationLedgerForTest(): void {
  registered.host = null;
  registered.commandsInstalled = false;
}
