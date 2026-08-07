// 하니스가 창에게 **능력을 묻는** 자리.
//
// 판정하는 쪽이 프레임워크의 이름을 보면, 그 이름이 하나 늘 때마다 판정 코드가 갈린다. 이름은
// 원장·진단의 것이고, 갈라지는 자리에는 두 개의 사실만 선다:
//
//   선언 — 프레임워크가 무엇을 제공한다고 말하는가(`framework.provision` 의 축).
//   답   — 그 창이 하니스가 부를 명령에 실제로 답하는가.
//
// 둘은 같은 사실이 아니다. 선언만 읽으면 "적어 뒀는데 아무도 답하지 않는" 공백이 통과하고, 답만
// 읽으면 선언이 거짓인 채로 남는다. 그래서 여기서 둘을 만나게 하고, 어긋나면 그 어긋남을 이름으로
// 남긴다(declared-not-answered / answered-not-declared).
//
// 부재는 조용할 수 없다. 창은 "그것이 여기 없다"를 **코드**로 답하고(UNKNOWN_COMMAND ·
// FRAMEWORK_CONCEPT_ABSENT · NOT_SERVED_HERE), 하니스는 그것을 통과로도 실패로도 뭉개지 않고
// 능력의 이름과 그 능력이 먹이는 게이트를 함께 적은 사유 한 줄로 옮긴다.
//
// 답이 오지 않은 것(타임아웃·정책 거절)은 부재가 아니다 — 재지 못한 것이다. 그 둘을 같은 값으로
// 표현하면 "없다"가 "못 쟀다"를 가린다. 여기서는 unreadable 이라는 다른 이름을 갖는다.

/** 창이 "그 능력은 여기 없다"고 이름을 달아 답하는 방법. 이 밖의 실패는 부재가 아니다. */
export const CAPABILITY_ABSENCE_CODES = Object.freeze([
  // 이 창의 명령 표면에 그 이름이 없다.
  "UNKNOWN_COMMAND",
  // 프레임워크가 대응 개념 없음을 자기 사유와 함께 거절했다.
  "FRAMEWORK_CONCEPT_ABSENT",
  // 이 프로세스가 그 이름을 서빙하지 않는다.
  "NOT_SERVED_HERE",
]);

const absenceCodes = new Set(CAPABILITY_ABSENCE_CODES);

/**
 * 콘텐츠 표면이 페이지 밖 자식 층에 서고, 그 층을 공개 주소로 부를 수 있는가.
 *
 * witness 는 읽기 전용 명령 하나다 — 능력을 물으면서 상태를 바꾸면 그 질문 자체가 실험을
 * 오염시킨다. 이 능력이 있을 때 이어서 부르는 이름들을 여기 나열하지는 않는다: 아무도 읽지 않는
 * 목록은 반드시 하나 빠지고, 빠진 그 하나는 조용하다. 그 이름들의 부재는 부르는 자리가 자기
 * 이름을 달고 실패하는 것으로 드러난다.
 */
export const PANE_PRESENTATION_HOST = Object.freeze({
  id: "pane-presentation-host",
  concept: "페이지 밖 자식 표면 층과 그 층을 부르는 공개 주소",
  witness: "webview.pane.hosts",
  witnessParams: Object.freeze({}),
  provisionAxis: "nativeChildWebview",
  gates: Object.freeze([]),
});

/** 하니스가 창에 들어서며 늘 묻는 능력들. */
export const HARNESS_CAPABILITIES = Object.freeze([PANE_PRESENTATION_HOST]);

function displayProvisionAxis(axis, provision) {
  if (!axis) return null;
  const value = provision && typeof provision === "object" ? provision[axis] : undefined;
  return value === undefined ? null : { axis, value: value === true };
}

/**
 * 한 능력의 판정 — 선언과 답을 만나게 한다. 순수 함수다(부르는 자리와 판정하는 자리를 나눈다).
 *
 * status 는 셋뿐이다: available(답했다) · absent(없다고 이름을 달고 답했다) ·
 * unreadable(답 자체를 못 얻었다). 넷째는 만들지 않는다 — 애매한 상태가 하나 생길 때마다 부르는
 * 쪽에 "그럴 땐 통과시키자"는 자리가 함께 생긴다.
 */
export function judgeCapabilityAnswer({
  id,
  witness,
  gates = [],
  provisionAxis = null,
  provision = null,
  answer,
}) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("capability id는 비어 있지 않은 이름이어야 한다");
  }
  if (typeof witness !== "string" || witness.trim() === "") {
    throw new TypeError(`${id}: capability witness 명령이 없다`);
  }
  const declaredAxis = displayProvisionAxis(provisionAxis, provision);
  const declared = declaredAxis ? declaredAxis.value : null;
  const answered = answer?.ok === true;
  const code = answered ? null : String(answer?.code ?? "NO_ANSWER");
  const message = typeof answer?.message === "string" ? answer.message : "";
  const notes = [];
  const parts = [`witness=${witness}`];
  if (!answered) parts.push(`code=${code}`);
  if (declaredAxis) parts.push(`declared=${declaredAxis.axis}:${declaredAxis.value}`);
  if (gates.length) parts.push(`gates=${gates.join(",")}`);
  if (message) parts.push(`message=${message}`);

  if (answered) {
    // 선언이 없다고 말한 것을 창이 답했다. 부르는 쪽은 답을 쓰지만, 어긋남은 이름으로 남는다.
    if (declared === false) notes.push("answered-not-declared");
    return Object.freeze({
      id,
      witness,
      gates: Object.freeze([...gates]),
      status: "available",
      code: null,
      declared,
      notes: Object.freeze(notes),
      reason: null,
    });
  }

  if (absenceCodes.has(code)) {
    // 적어 둔 계약은 읽혀야 한다 — 선언이 있는데 답이 없으면 그 자체가 결함의 이름이다.
    if (declared === true) notes.push("declared-not-answered");
    const reason = [
      `capability-absent: ${id}`,
      [...parts, ...notes.map((note) => `(${note})`)].join(" "),
    ].join(" — ");
    return Object.freeze({
      id,
      witness,
      gates: Object.freeze([...gates]),
      status: "absent",
      code,
      declared,
      notes: Object.freeze(notes),
      reason,
    });
  }

  return Object.freeze({
    id,
    witness,
    gates: Object.freeze([...gates]),
    status: "unreadable",
    code,
    declared,
    notes: Object.freeze(notes),
    reason: `capability-unreadable: ${id} — ${parts.join(" ")}`,
  });
}

/** 능력 하나를 창에 묻는다 — witness 하나만 부른다. */
export async function askCapability(rpc, windowLabel, capability, provision = null) {
  const answer = await Promise.resolve(
    rpc(capability.witness, capability.witnessParams ?? {}, windowLabel),
  ).catch((error) => ({
    ok: false,
    code: "HARNESS_NO_ANSWER",
    message: error instanceof Error ? error.message : String(error),
  }));
  return judgeCapabilityAnswer({
    id: capability.id,
    witness: capability.witness,
    gates: capability.gates ?? [],
    provisionAxis: capability.provisionAxis ?? null,
    provision,
    answer,
  });
}

/**
 * presentation trace 능력 — witness 는 **어댑터 자신이 선언한 owner 명령**이다.
 *
 * 어느 명령이 이 궤적의 입구인지 아는 것은 어댑터다. 하니스가 이름을 하나 더 적으면 그것이 두
 * 번째 진실이 되고, 두 벌은 갈릴 때까지 조용하다. provisionAxis 는 어댑터가 선언할 때만 쓴다 —
 * 표면을 어디에 세우는지는 구현마다 다르고, 그 축을 하니스가 대신 골라 주면 남의 능력을 남의
 * 축으로 판정하게 된다.
 */
export function presentationTraceCapability(adapter, gates = ["B04", "B05"]) {
  const ownerCommand = adapter?.ownerCommand;
  if (typeof ownerCommand !== "string" || ownerCommand.trim() === "") {
    throw new TypeError("presentation trace 어댑터가 owner 명령을 선언하지 않았다");
  }
  const ownerParams = typeof adapter.ownerParams === "function"
    ? adapter.ownerParams
    : () => ({});
  return Object.freeze({
    id: "flow-presentation-trace",
    concept: "표시 시계가 실제로 낸 표면 프레임의 유한 원장",
    witness: ownerCommand,
    witnessParams: Object.freeze(ownerParams({}) ?? {}),
    provisionAxis: adapter.provisionAxis ?? null,
    gates: Object.freeze([...gates]),
  });
}

/**
 * 이 창의 능력을 한 번에 읽는다. 선언은 한 번만 묻고(창마다 하나의 사실), 능력마다 witness 를
 * 부른다. 못 읽은 능력은 이름을 달고 던진다 — 재지 못한 것을 없는 것으로 읽지 않는다.
 */
/**
 * 이 창이 무엇을 대주는지 창에게 묻고, 그 답을 값으로만 돌려준다.
 *
 * 거절도 침묵도 값이 아니다 — 못 물어본 실행이 물어보고 확인한 실행과 같은 값을 내면, 그 뒤에
 * 나는 red 에 엉뚱한 이름이 붙는다. 갈라지는 자리는 전부 이 한 자리를 통해 읽는다.
 */
export async function readProvision(rpc, windowLabel) {
  const answer = await Promise.resolve(rpc("framework.provision", {}, windowLabel));
  if (answer?.ok !== true) {
    throw new Error(`framework.provision 을 읽지 못했다: ${JSON.stringify(answer)?.slice(0, 240)}`);
  }
  const provision = answer.data ?? {};
  if (typeof provision.nativeChildWebview !== "boolean") {
    throw new Error(
      `framework 가 nativeChildWebview 를 선언하지 않았다: ${JSON.stringify(provision)?.slice(0, 240)}`,
    );
  }
  return provision;
}

export async function readHarnessCapabilities(rpc, windowLabel, options = {}) {
  const declared = options.capabilities ?? HARNESS_CAPABILITIES;
  const provision = await readProvision(rpc, windowLabel);
  const entries = new Map();
  for (const capability of declared) {
    const verdict = await askCapability(rpc, windowLabel, capability, provision);
    if (verdict.status === "unreadable") throw new Error(verdict.reason);
    entries.set(verdict.id, verdict);
  }
  return Object.freeze({
    provision,
    entries,
    verdict: (id) => entries.get(id) ?? null,
    has: (id) => entries.get(id)?.status === "available",
    absence: (id) => entries.get(id)?.reason ?? null,
    /** 이 창에서 아직 안 물어본 능력을 그 자리에서 묻는다(어댑터에서 파생된 능력용). */
    ask: async (capability) => {
      const verdict = await askCapability(rpc, windowLabel, capability, provision);
      entries.set(verdict.id, verdict);
      return verdict;
    },
  });
}

/**
 * 한 셀의 판정 — 능력이 답했으면 실제 증거를 기록하고, 없으면 그 셀만 능력의 이름으로 닫는다.
 *
 * 없는 능력 위에서 증거를 만들면 그 판정은 측정이 아니라 창작이다. 아무것도 적지 않으면 not-run
 * 으로 묻힌다. 둘 다 "재지 않았다"를 다른 것으로 말하는 것이라, 여기서는 사유가 실린 blocked 만
 * 답이다. 닫는 일도 보고서의 소유 검사(`recordMachineStatus`)를 그대로 지난다 — 능력 부재가
 * 남의 칸을 닫을 이유는 아니다.
 */
export function recordGateOrCapabilityAbsence(
  store,
  { framework, engine, gate, evidence, capability, unmeasured = [] },
) {
  const status = capability?.status;
  if (status === "unreadable") throw new Error(capability.reason);
  // 능력은 있는데 이 실행이 그 축을 못 잰 자리들 — 무장을 못 얻은 전이가 그렇다. 없는 증거로
  // red 를 적지도, 아무 말 없이 통과시키지도 않는다.
  if (Array.isArray(unmeasured) && unmeasured.length > 0) {
    const reason = unmeasured.join(" · ");
    return store.recordMachineStatus({
      framework,
      engine,
      gate,
      status: "blocked",
      evidence: [...unmeasured],
      reason,
    });
  }
  if (status === "absent") {
    return store.recordMachineStatus({
      framework,
      engine,
      gate,
      status: "blocked",
      evidence: [capability.reason],
      reason: capability.reason,
    });
  }
  return store.recordMachineEvidence({ framework, engine, gate, evidence });
}
