import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBrowserGateReportStore } from "./browser-evidence-store.mjs";
import { browserGatesOwnedBy } from "./browser-gate-report-merge.mjs";
import {
  CAPABILITY_ABSENCE_CODES,
  PANE_PRESENTATION_HOST,
  readProvision,
  askCapability,
  judgeCapabilityAnswer,
  presentationTraceCapability,
  readHarnessCapabilities,
  recordGateOrCapabilityAbsence,
} from "./harness-capabilities.mjs";

const answerOk = (data = {}) => ({ ok: true, data });
const answerCode = (code, message = "") => ({ ok: false, code, message });

describe("judgeCapabilityAnswer", () => {
  it("reads an answering command as the capability being present", () => {
    const verdict = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      answer: answerOk({ count: 2 }),
    });
    expect(verdict.status).toBe("available");
    expect(verdict.reason).toBeNull();
    expect(verdict.code).toBeNull();
  });

  it("names every declared absence code as absence, never as a pass", () => {
    for (const code of CAPABILITY_ABSENCE_CODES) {
      const verdict = judgeCapabilityAnswer({
        id: "flow-presentation-trace",
        witness: "view.presentation.owners",
        gates: ["B04", "B05"],
        answer: answerCode(code, "이 프레임워크엔 대응 개념이 없다"),
      });
      expect(verdict.status).toBe("absent");
      expect(verdict.code).toBe(code);
      expect(verdict.reason).toContain("capability-absent: flow-presentation-trace");
      expect(verdict.reason).toContain("witness=view.presentation.owners");
      expect(verdict.reason).toContain(`code=${code}`);
      expect(verdict.reason).toContain("gates=B04,B05");
    }
  });

  it("keeps the window's own absence sentence in the reason", () => {
    const verdict = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      answer: answerCode("FRAMEWORK_CONCEPT_ABSENT", "페이지 밖 자식 층이 없다"),
    });
    expect(verdict.reason).toContain("페이지 밖 자식 층이 없다");
  });

  it("refuses to read an unexpected failure as absence", () => {
    const verdict = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      answer: answerCode("PERMISSION_DENIED", "정책이 막았다"),
    });
    expect(verdict.status).toBe("unreadable");
    expect(verdict.reason).toContain("capability-unreadable: pane-presentation-host");
    expect(verdict.reason).toContain("code=PERMISSION_DENIED");
  });

  it("names a declaration that no answer backs", () => {
    const verdict = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      provisionAxis: "nativeChildWebview",
      provision: { nativeChildWebview: true },
      answer: answerCode("UNKNOWN_COMMAND", "알 수 없는 명령"),
    });
    expect(verdict.status).toBe("absent");
    expect(verdict.declared).toBe(true);
    expect(verdict.reason).toContain("declared-not-answered");
    expect(verdict.reason).toContain("declared=nativeChildWebview:true");
  });

  it("names an answer that no declaration backs, and still uses the answer", () => {
    const verdict = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      provisionAxis: "nativeChildWebview",
      provision: { nativeChildWebview: false },
      answer: answerOk({ count: 1 }),
    });
    expect(verdict.status).toBe("available");
    expect(verdict.declared).toBe(false);
    expect(verdict.notes).toContain("answered-not-declared");
  });

  it("judges the same answer the same way whoever answered it", () => {
    const one = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      provision: { name: "framework-a", nativeChildWebview: false },
      answer: answerCode("UNKNOWN_COMMAND", ""),
    });
    const other = judgeCapabilityAnswer({
      id: "pane-presentation-host",
      witness: "webview.pane.hosts",
      provision: { name: "framework-b", nativeChildWebview: false },
      answer: answerCode("UNKNOWN_COMMAND", ""),
    });
    expect(one.status).toBe(other.status);
    expect(one.reason).toBe(other.reason);
  });
});

describe("askCapability", () => {
  it("asks the witness once and nothing else", async () => {
    const calls = [];
    const rpc = async (method, params, win) => {
      calls.push({ method, params, win });
      return answerOk({ count: 0 });
    };
    const verdict = await askCapability(rpc, "w-1", PANE_PRESENTATION_HOST, {
      nativeChildWebview: true,
    });
    expect(calls).toEqual([
      { method: PANE_PRESENTATION_HOST.witness, params: {}, win: "w-1" },
    ]);
    expect(verdict.status).toBe("available");
  });

  it("turns a dead socket into an unreadable verdict, not into absence", async () => {
    const rpc = async () => {
      throw new Error("TIMEOUT webview.pane.hosts");
    };
    const verdict = await askCapability(rpc, "w-1", PANE_PRESENTATION_HOST, {});
    expect(verdict.status).toBe("unreadable");
    expect(verdict.reason).toContain("TIMEOUT");
  });
});

describe("presentationTraceCapability", () => {
  it("takes the witness from the adapter's own owner command", () => {
    const capability = presentationTraceCapability({
      ownerCommand: "view.presentation.owners",
      ownerParams: () => ({}),
    });
    expect(capability.witness).toBe("view.presentation.owners");
    expect(capability.gates).toEqual(["B04", "B05"]);
  });

  it("refuses an adapter that declares no owner command", () => {
    expect(() => presentationTraceCapability({})).toThrow(/owner/);
  });
});

describe("readHarnessCapabilities", () => {
  it("reads the framework provision once and answers by capability id", async () => {
    const asked = [];
    const rpc = async (method, params, win) => {
      asked.push(method);
      if (method === "framework.provision") {
        return answerOk({ name: "any", nativeChildWebview: false });
      }
      return answerCode("UNKNOWN_COMMAND", `알 수 없는 명령: ${method} (${win})`);
    };
    const capabilities = await readHarnessCapabilities(rpc, "w-1");
    expect(asked[0]).toBe("framework.provision");
    expect(asked.filter((method) => method === "framework.provision")).toHaveLength(1);
    expect(capabilities.has(PANE_PRESENTATION_HOST.id)).toBe(false);
    expect(capabilities.absence(PANE_PRESENTATION_HOST.id)).toContain("capability-absent");
    expect(capabilities.provision.nativeChildWebview).toBe(false);
  });

  it("answers present when the window answers the witness", async () => {
    const rpc = async (method) => (method === "framework.provision"
      ? answerOk({ name: "any", nativeChildWebview: true })
      : answerOk({ count: 2, hosts: [] }));
    const capabilities = await readHarnessCapabilities(rpc, "w-1");
    expect(capabilities.has(PANE_PRESENTATION_HOST.id)).toBe(true);
    expect(capabilities.absence(PANE_PRESENTATION_HOST.id)).toBeNull();
  });

  it("throws on an unreadable capability instead of guessing", async () => {
    const rpc = async (method) => (method === "framework.provision"
      ? answerOk({ name: "any", nativeChildWebview: true })
      : answerCode("PERMISSION_DENIED", "정책이 막았다"));
    await expect(readHarnessCapabilities(rpc, "w-1")).rejects.toThrow(/capability-unreadable/);
  });

  it("names a provision it could not read instead of assuming an empty declaration", async () => {
    const rpc = async () => answerCode("UNKNOWN_COMMAND", "알 수 없는 명령");
    await expect(readHarnessCapabilities(rpc, "w-1")).rejects.toThrow(/framework\.provision/);
  });
});

describe("recordGateOrCapabilityAbsence", () => {
  const liveStore = (runId) => createBrowserGateReportStore({
    root: path.join("/tmp", `soksak-harness-capability-${runId}`),
    buildId: "build-1",
    runId,
    platform: "darwin",
    gates: browserGatesOwnedBy("slot-freeze"),
  });

  const absentTrace = () => judgeCapabilityAnswer({
    id: "flow-presentation-trace",
    witness: "view.presentation.owners",
    gates: ["B04", "B05"],
    answer: answerCode("UNKNOWN_COMMAND", "알 수 없는 명령"),
  });

  it("records real evidence when the capability answered", () => {
    const calls = { recorded: [], blocked: [] };
    const receipt = recordGateOrCapabilityAbsence({
      recordMachineEvidence(entry) {
        calls.recorded.push(entry);
        return { status: "green", evidence: [] };
      },
      recordMachineStatus(entry) {
        calls.blocked.push(entry);
        return { status: entry.status, evidence: entry.evidence, reason: entry.reason };
      },
    }, {
      framework: "any",
      engine: "browser",
      gate: "B04",
      evidence: { engine: "browser" },
      capability: { status: "available", reason: null },
    });
    expect(receipt.status).toBe("green");
    expect(calls.recorded).toHaveLength(1);
    expect(calls.blocked).toHaveLength(0);
  });

  // 한 셀만 사유와 함께 닫는다. 이 자리가 없으면 부르는 쪽은 둘 중 하나를 한다: 없는 증거로
  // red 를 적거나, 아무것도 안 적어 not-run 으로 묻는다. 둘 다 재지 않은 것을 다른 것으로 말한다.
  it("closes one named cell with the capability's reason and leaves the rest measurable", () => {
    const store = liveStore("run-capability-block");
    store.bindFramework("tauri");
    const capability = absentTrace();
    const receipt = recordGateOrCapabilityAbsence(store, {
      framework: "tauri",
      engine: "browser",
      gate: "B04",
      evidence: { engine: "browser" },
      capability,
    });
    expect(receipt.status).toBe("blocked");
    expect(receipt.reason).toBe(capability.reason);
    expect(receipt.evidence).toEqual([capability.reason]);
    const report = store.report();
    expect(report.engines.browser.B04.machine.status).toBe("blocked");
    expect(report.engines.browser.B04.machine.reason).toBe(capability.reason);
    // 한 칸을 못 잰다는 사실은 옆 칸을, 옆 엔진을 못 잴 이유가 아니다.
    expect(report.engines.browser.B06.machine.status).toBe("not-run");
    expect(report.engines["browser-chromium"].B04.machine.status).toBe("not-run");
  });

  it("passes the store's gate ownership check instead of bypassing it", () => {
    const store = liveStore("run-capability-ownership");
    store.bindFramework("tauri");
    // B12 는 냉시작 실행기의 칸이다 — 능력 부재도 남의 칸을 닫지 못한다.
    expect(() => recordGateOrCapabilityAbsence(store, {
      framework: "tauri",
      engine: "browser",
      gate: "B12",
      evidence: {},
      capability: absentTrace(),
    })).toThrow(/B12/);
  });

  it("refuses to pass an unreadable capability off as an absence", () => {
    const store = liveStore("run-capability-unreadable");
    store.bindFramework("tauri");
    expect(() => recordGateOrCapabilityAbsence(store, {
      framework: "tauri",
      engine: "browser",
      gate: "B04",
      evidence: {},
      capability: { status: "unreadable", reason: "capability-unreadable: x" },
    })).toThrow(/capability-unreadable/);
  });
});

describe("the capability question itself", () => {
  it("never asks who the framework is", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "harness-capabilities.mjs"),
      "utf8",
    );
    // 판정이 이름을 보면 프레임워크가 하나 늘 때마다 이 파일이 갈린다.
    expect(source).not.toMatch(/tauri/i);
    expect(source).not.toMatch(/electron/i);
  });
});

// 못 물어본 실행이 물어보고 확인한 실행과 같은 값을 내면 안 된다.
//
// 실측 2026-08-07: gutter-drag.mjs:165 와 surface-park.mjs:96 이 `provision.nativeChildWebview
// !== false` 로 읽었다. 그 헬퍼는 거절 봉투를 조용히 통과시키므로, framework.provision 이
// UNKNOWN_COMMAND 로 거절돼도 두 줄 다 "네이티브 자식 표면이 있다"로 접혔다 — 그 뒤 네이티브
// 표면을 못 찾은 red 에 "child 판독 실패"라는 엉뚱한 이름이 붙는다.
describe("readProvision", () => {
  it("선언된 축을 그대로 답한다", async () => {
    const provision = await readProvision(
      async () => ({ ok: true, data: { name: "tauri", nativeChildWebview: true } }),
      "main",
    );
    expect(provision.nativeChildWebview).toBe(true);
    expect(provision.name).toBe("tauri");
  });

  it("거절 봉투를 값으로 읽지 않는다", async () => {
    await expect(
      readProvision(async () => ({ ok: false, code: "UNKNOWN_COMMAND" }), "main"),
    ).rejects.toThrow(/framework\.provision/);
  });

  it("축을 선언하지 않은 답을 있음으로 읽지 않는다", async () => {
    await expect(
      readProvision(async () => ({ ok: true, data: { name: "electron" } }), "main"),
    ).rejects.toThrow(/nativeChildWebview/);
  });

  it("boolean 이 아닌 선언을 통과시키지 않는다", async () => {
    await expect(
      readProvision(async () => ({ ok: true, data: { nativeChildWebview: "yes" } }), "main"),
    ).rejects.toThrow(/nativeChildWebview/);
  });
});
