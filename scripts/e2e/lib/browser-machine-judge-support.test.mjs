// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WIRING_KEY,
  finishMachineVerdict,
  mapWithWiring,
  readCheckpoint,
  requireEvidenceEnvelope,
  requireExactKeys,
} from "./browser-machine-judge-support.mjs";

function wiring({ source = "checkpoint", unconsumed = [], unproduced = [], error = null } = {}) {
  return { source, unconsumed, unproduced, error };
}

describe("requireExactKeys", () => {
  it("names both an unexpected key and a missing key", () => {
    const failures = [];
    expect(requireExactKeys({ a: 1, b: 2 }, ["a", "c"], "evidence", failures)).toBe(true);
    expect(failures).toEqual(["evidence.b=not-machine-schema", "evidence.c=missing"]);
  });

  it("rejects a non-record before naming keys", () => {
    const failures = [];
    expect(requireExactKeys(null, ["a"], "evidence", failures)).toBe(false);
    expect(failures).toEqual(["evidence=record/null"]);
  });
});

describe("evidence wiring ledger", () => {
  it("is not counted as a schema violation of the gate envelope", () => {
    const failures = [];
    requireExactKeys({ a: 1, [EVIDENCE_WIRING_KEY]: wiring() }, ["a"], "evidence", failures);
    expect(failures).toEqual([]);
  });

  it("names a produced field that no consumer read", () => {
    const failures = [];
    requireExactKeys(
      { a: 1, [EVIDENCE_WIRING_KEY]: wiring({ source: "B06.live", unconsumed: ["railComposition"] }) },
      ["a"],
      "evidence",
      failures,
    );
    expect(failures).toEqual(["wiring.B06.live.railComposition=produced-not-consumed"]);
  });

  it("names a consumed field that no producer wrote", () => {
    const failures = [];
    requireExactKeys(
      { a: 1, [EVIDENCE_WIRING_KEY]: wiring({ source: "B06.live", unproduced: ["rail"] }) },
      ["a"],
      "evidence",
      failures,
    );
    expect(failures).toEqual(["wiring.B06.live.rail=consumed-not-produced"]);
  });

  it("names both directions of one drifted field name", () => {
    const failures = [];
    requireExactKeys(
      {
        a: 1,
        [EVIDENCE_WIRING_KEY]: wiring({
          source: "B06.live",
          unconsumed: ["railComposition"],
          unproduced: ["rail"],
        }),
      },
      ["a"],
      "evidence",
      failures,
    );
    expect(failures).toEqual([
      "wiring.B06.live.railComposition=produced-not-consumed",
      "wiring.B06.live.rail=consumed-not-produced",
    ]);
  });

  it("names a mapper that threw instead of letting it kill the harness", () => {
    const failures = [];
    requireExactKeys(
      { a: 1, [EVIDENCE_WIRING_KEY]: wiring({ source: "B06.live", error: "TypeError: boom" }) },
      ["a"],
      "evidence",
      failures,
    );
    expect(failures).toEqual(['wiring.B06.live=mapper-threw/"TypeError: boom"']);
  });

  it("rejects a malformed ledger instead of reading it as clean", () => {
    const failures = [];
    requireExactKeys({ [EVIDENCE_WIRING_KEY]: { source: "x", unconsumed: "railComposition" } }, [], "evidence", failures);
    expect(failures).toEqual([
      'evidence.evidenceWiring.unconsumed=names/"railComposition"',
      "evidence.evidenceWiring.unproduced=names/undefined",
    ]);
  });

  it("reaches gates whose envelope is not key-closed", () => {
    const failures = [];
    requireEvidenceEnvelope(
      {
        engine: "browser",
        tabs: [{}],
        [EVIDENCE_WIRING_KEY]: wiring({ source: "B01.live", unproduced: ["mounted"] }),
      },
      failures,
    );
    expect(failures).toEqual(["wiring.B01.live.mounted=consumed-not-produced"]);
  });

  it("stays silent when no envelope carries a ledger", () => {
    const failures = [];
    requireExactKeys({ a: 1 }, ["a"], "evidence", failures);
    expect(failures).toEqual([]);
  });
});

describe("readCheckpoint", () => {
  it("seals a checkpoint whose every produced field was read", () => {
    const reader = readCheckpoint({ engine: "browser", scaleFactor: 2 }, "B03.live");
    expect(reader.take("engine")).toBe("browser");
    expect(reader.take("scaleFactor")).toBe(2);
    expect(reader.seal()).toEqual({
      source: "B03.live",
      unconsumed: [],
      unproduced: [],
      error: null,
    });
  });

  it("seals both sides of a renamed field", () => {
    const reader = readCheckpoint({ railComposition: 1 }, "B06.live");
    expect(reader.take("rail")).toBeUndefined();
    expect(reader.seal()).toEqual({
      source: "B06.live",
      unconsumed: ["railComposition"],
      unproduced: ["rail"],
      error: null,
    });
  });

  it("does not read a missing checkpoint as an empty one", () => {
    const reader = readCheckpoint(null, "B03.live");
    reader.take("engine");
    const sealed = reader.seal();
    expect(sealed.unproduced).toEqual(["engine"]);
    expect(sealed.error).toBe("checkpoint is not a record: null");
  });
});

describe("mapWithWiring", () => {
  it("attaches the ledger to the mapped envelope", () => {
    const mapped = mapWithWiring({ engine: "browser" }, "B03.live", (checkpoint) => ({
      engine: checkpoint.take("engine"),
    }));
    expect(mapped).toEqual({
      engine: "browser",
      [EVIDENCE_WIRING_KEY]: { source: "B03.live", unconsumed: [], unproduced: [], error: null },
    });
  });

  it("returns a named envelope instead of throwing out of the harness", () => {
    let mapped;
    expect(() => {
      mapped = mapWithWiring({ engine: "browser" }, "B03.live", () => {
        throw new TypeError("boom");
      });
    }).not.toThrow();
    expect(mapped[EVIDENCE_WIRING_KEY].error).toBe("TypeError: boom");
    const failures = [];
    requireExactKeys(mapped, ["engine"], "evidence", failures);
    expect(failures).toEqual([
      "evidence.engine=missing",
      // 던지느라 읽지 못한 필드도 사실 그대로 남는다.
      "wiring.B03.live.engine=produced-not-consumed",
      'wiring.B03.live=mapper-threw/"TypeError: boom"',
    ]);
  });

  it("does not accept a non-record envelope as a mapped envelope", () => {
    const mapped = mapWithWiring({}, "B03.live", () => null);
    expect(mapped[EVIDENCE_WIRING_KEY].error).toBe("TypeError: mapper returned null");
  });

  it("carries a JSON round trip so the report keeps the names", () => {
    const mapped = mapWithWiring({ railComposition: 1 }, "B06.live", (checkpoint) => ({
      rail: checkpoint.take("rail") ?? null,
    }));
    const failures = [];
    requireExactKeys(JSON.parse(JSON.stringify(mapped)), ["rail"], "evidence", failures);
    expect(failures).toEqual([
      "wiring.B06.live.railComposition=produced-not-consumed",
      "wiring.B06.live.rail=consumed-not-produced",
    ]);
  });
});

// 잰 값과 못 잼은 다른 답이다.
//
// 관측자가 표본을 못 낸 것을 실패로 적으면 없는 사실을 만든 것이고, 그 판정은 관측 환경에 따라
// green/red 를 오간다 — 실측 2026-08-07: presentation-frame 표본이 rAF 에 달려 있어 창이
// 가려지면 B04 가 red, 아니면 green 이었다. 제품은 그대로였다.
describe("측정 불가는 실패가 아니다", () => {
  it("못 잰 축이 있으면 사유와 함께 blocked 를 답한다", () => {
    const verdict = finishMachineVerdict("B04", [], "B04:ok", ["slot"]);
    expect(verdict.status).toBe("blocked");
    expect(verdict.reason).toContain("slot");
    expect(verdict.evidence).toEqual([]);
  });

  it("실패가 함께 있으면 red 가 이긴다 — 잰 어긋남은 못 잼에 가려지지 않는다", () => {
    const verdict = finishMachineVerdict("B04", ["pane-dx=1/0"], "B04:ok", ["slot"]);
    expect(verdict.status).toBe("red");
    expect(verdict.evidence).toEqual(["B04:pane-dx=1/0"]);
  });

  it("못 잰 축이 없으면 지금 계약 그대로다", () => {
    expect(finishMachineVerdict("B04", [], "B04:ok", []).status).toBe("green");
    expect(finishMachineVerdict("B04", ["x=1/0"], "B04:ok").status).toBe("red");
  });
});
