// 셸의 것 — 창·웹뷰·네이티브 표면 명령. 이 표는 소켓 앞에 선다.
//
// 이 명령들은 cored 로 갈 수 없다: 다른 프로세스엔 창이 없다. 그래서 발견은 **이름**으로 한다.
// 아래 갈래 접두사를 단 이름은 전부 셸의 영역이고, 소켓 너머로 새지 않는다.
//
// 표는 갈래마다 한 파일이다(window.cjs·webview.cjs·engine.cjs·titlebar.cjs). 한 파일이 표
// 전체를 쥐면 갈래를 채우는 사람들이 같은 파일에서 부딪힌다 — 여기서는 자기 갈래 파일만 쥔다.
//
// 표는 두 줄만 구분한다.
//   answer — 이 셸이 아는 사실. Electron API 나 셸 자신의 레지스트리가 답한다.
//   absent — 이 셸에 대응 개념이 없다. 이름(FRAMEWORK_CONCEPT_ABSENT)을 달고 거절한다.
//
// 없는 것을 조용히 성공시키지 않는 이유: UI 는 성공을 받으면 그 기능이 있다고 믿고 그 믿음대로
// 그린다(홀 위에 그리는 강조 바, 오버레이 게이트에 기대는 모달). 없다고 답해야 UI 가 그에 맞게
// 그릴 수 있고, 그 사유는 framework_capabilities 로 읽힌다.
//
// "부재"를 답으로 쓰는 기준: 셸이 **증명할 수 있는 부재**만 값으로 답한다(자기가 만든 것의
// 목록이 비었다 = 실측). 관측할 수단조차 없는 것(사이드카가 창에 붙이는 엔진 서피스)은 0 을
// 돌려주지 않는다 — 재지 않은 것을 쟀다고 말하는 것이 곧 가짜 성공이다.

const { ABSENT_CODE, frameworkError } = require("./error.cjs");

/** 표에 **없는** 이름을 위한 그물. 이 접두사면 등재 여부와 무관하게 소켓으로 가지 않는다.
 *
 *  표에 실린 이름에는 갈래가 필요 없다 — 등재 자체가 주장이고 claims() 가 `cmd in TABLE` 을
 *  본다. 한때 갈래 밖 이름을 적재에서 거부하며 "표에 실려도 발견되지 않는다"고 적었는데 바로
 *  아래 코드가 그 말을 반증한다. 그 제약은 project_claim 을 막고 있었다: 창을 소유한 쪽이
 *  져야 하는데(root→창 라벨 지도의 수명이 곧 창의 수명이다) project_ 는 갈래가 아니었다.
 *  project_ 를 갈래로 만드는 것도 답이 아니다 — ensure_project_dir 은 파일시스템이라 cored 의
 *  것이고, 갈래로 만들면 그것까지 셸이 삼킨다.
 *
 *  목록은 장부(src-tauri/src/cored_ledger.rs SHELL_FAMILIES)와 한 벌이어야 한다 —
 *  갈라지면 "장부는 셸의 것이라 하는데 셸은 안 받는" 이름이 생기고 어느 쪽에도 안 잡힌다. */
const BRANCHES = ["window_", "webview_", "engine_", "titlebar_"];

/** 갈래 밖에 서는 유일한 이름. 표 자신을 읽는 자리라 어느 갈래에도 속하지 않는다. */
const CAPABILITIES = "framework_capabilities";

const isShellBranch = (cmd) => BRANCHES.some((p) => String(cmd).startsWith(p));

/** 갈래 파일들을 한 표로 합친다. 합치기가 곧 검사다 — 갈래 밖 이름과 중복 선언은 적재에서 죽는다.
 *  나중에 알면 늦는다: 중복은 나중 파일이 앞 파일을 조용히 덮고, 갈래 밖 이름은 소켓으로 샌다. */
function assemble(modules) {
  const table = {};
  const owner = new Map();
  for (const [file, entries] of modules) {
    for (const [cmd, entry] of Object.entries(entries)) {
      if (owner.has(cmd)) {
        throw new Error(`${cmd} 를 두 파일이 선언했다: ${owner.get(cmd)}, ${file}`);
      }
      owner.set(cmd, file);
      table[cmd] = entry;
    }
  }
  return table;
}

const TABLE = assemble([
  ["window.cjs", require("./window.cjs")],
  ["webview.cjs", require("./webview.cjs")],
  ["engine.cjs", require("./engine.cjs")],
  ["titlebar.cjs", require("./titlebar.cjs")],
  ["project.cjs", require("./project.cjs")],
]);

// 능력면 — UI 가 그리기 전에 물어볼 수 있는 자리. 표 자체가 답이라 선언과 행동이 갈릴 수 없다.
TABLE[CAPABILITIES] = {
  concept: "셸 네이티브 명령 능력표",
  source: "이 표",
  answer: () => ({
    shell: "electron",
    commands: Object.fromEntries(
      Object.entries(TABLE).map(([cmd, e]) => [
        cmd,
        e.absent
          ? { supported: false, concept: e.concept, reason: e.absent }
          : { supported: true, concept: e.concept, source: e.source },
      ]),
    ),
  }),
};

/** 이 이름은 셸이 답한다 — 등재됐거나, 셸 갈래이거나. 나머지는 백엔드의 것이다. */
const claims = (cmd) => cmd === CAPABILITIES || isShellBranch(cmd) || cmd in TABLE;

/** 갈래는 셸의 것인데 표에 없다. 사유를 지어내지 않고 "이 셸엔 없다"만 말한다. */
const unlisted = (cmd) => ({
  concept: cmd,
  absent: `이 셸엔 ${cmd} 에 대응하는 개념이 없다 — 셸 갈래 이름이므로 백엔드로 넘기지 않는다(그 프로세스엔 창이 없다).`,
});

/** 네이티브 명령 한 건. 답도 거절도 원장에 셸의 것으로 남는다(record 가 그 자리다). */
function serve(cmd, args, ctx, record) {
  const entry = TABLE[cmd] || unlisted(cmd);
  if (entry.absent) {
    record(cmd, false, ABSENT_CODE, "shell");
    return { ok: false, code: ABSENT_CODE, message: `${entry.concept}: ${entry.absent}`, command: cmd };
  }
  try {
    const value = entry.answer(ctx, args ?? {});
    record(cmd, true, undefined, "shell");
    return { ok: true, value };
  } catch (e) {
    const code = e.code || "ERROR";
    record(cmd, false, code, "shell");
    return { ok: false, code, message: String(e.message || e), command: cmd };
  }
}

module.exports = { ABSENT_CODE, BRANCHES, CAPABILITIES, claims, isShellBranch, serve, frameworkError };
