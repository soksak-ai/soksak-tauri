// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_WIRING_KEY,
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
