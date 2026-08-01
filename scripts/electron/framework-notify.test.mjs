// @vitest-environment node
// OS 알림의 기준 — 조용한 성공을 금지한다.
//
// 알림은 부른 쪽이 결과를 볼 수 없는 표면이다. 안 떴는데 성공을 돌려주면 그 위에 세운 흐름이
// 통째로 거짓이 되고("사용자에게 알렸다"), 그 거짓은 어디에서도 오류로 보이지 않는다.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE = join(HERE, "../../frameworks/electron/native");

let shown;
let supported;
/** 알림이 건 사건 핸들러 — 클릭이 어디로 가는지 재는 자리. */
let clicks;

/** electron 을 손으로 세운다 — 좁은 스텁은 실물과의 차이가 곧 거짓 GREEN 이다. */
function stubElectron() {
  const path = requireCjs.resolve("electron");
  requireCjs.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: {
      Notification: class {
        static isSupported() {
          return supported;
        }
        constructor(opts) {
          this.opts = opts;
        }
        // 실제 알림은 클릭 사건을 낸다 — 목이 안 내면 이 검사가 실제와 다른 세계를 잰다.
        on(event, cb) {
          clicks.set(event, cb);
          return this;
        }
        show() {
          shown.push(this.opts);
        }
      },
    },
  };
}

function loadTable() {
  for (const f of ["notify.cjs", "error.cjs"]) {
    delete requireCjs.cache[requireCjs.resolve(join(NATIVE, f))];
  }
  return requireCjs(join(NATIVE, "notify.cjs"));
}

beforeEach(() => {
  shown = [];
  clicks = new Map();
  supported = true;
  stubElectron();
});

afterEach(() => {
  delete requireCjs.cache[requireCjs.resolve("electron")];
});

describe("OS 알림", () => {
  it("제목과 본문을 그대로 띄운다", () => {
    const table = loadTable();
    expect(table.notify_show.answer({}, { title: "제목", body: "본문" })).toEqual({ handle: 1 });
    expect(shown).toEqual([{ title: "제목", body: "본문" }]);
  });

  /** 무엇이 유효한 알림인가는 여기서 판정하지 않는다 — 규칙이 프레임워크에 살면 두 껍데기가
   *  같은 이름에 다른 기준을 갖는다. 값이 없으면 빈 문자열로 그대로 넘긴다(Tauri 와 같다). */
  it("인자 판정을 하지 않는다 — 규칙은 프레임워크의 것이 아니다", () => {
    const table = loadTable();
    expect(table.notify_show.answer({}, {})).toEqual({ handle: 1 });
    expect(shown).toEqual([{ title: undefined, body: undefined }]);
  });

  /** 활성화에 **주소가 없으면** 사람 손가락 말고는 부를 길이 없다. 부를 수 없는 사건은
   *  동작한다고 말할 수 없다 — 띄운 알림은 handle 로 되부를 수 있어야 한다. */
  it("띄운 알림은 주소를 돌려준다", () => {
    const table = loadTable();
    const a = table.notify_show.answer({ deepLink: () => {} }, { title: "가", body: "나" });
    const b = table.notify_show.answer({ deepLink: () => {} }, { title: "다", body: "라" });
    expect(a.handle).not.toBe(b.handle);
  });

  /** **사람 손가락과 같은 문이다.** 활성화 경로가 둘이면 이 명령이 통과해도 클릭은 죽어 있을
   *  수 있고, 그때 이 검사는 아무것도 증명하지 않는다. 같은 함수인지를 잰다. */
  it("notify_activate 는 OS 클릭과 같은 함수를 부른다", () => {
    const table = loadTable();
    const sent = [];
    const ctx = { deepLink: (u) => sent.push(u) };
    const { handle } = table.notify_show.answer(ctx, {
      title: "제목",
      body: "본문",
      extra: { deepLink: "soksak-dev://cmd/bookmark.list" },
    });
    // 등록된 클릭 핸들러와 명령이 부르는 것이 **같은 함수**여야 한다.
    expect(table.notify_activate.answer({}, { handle })).toBe(null);
    expect(sent).toEqual(["soksak-dev://cmd/bookmark.list"]);
    clicks.get("click")();
    expect(sent).toEqual(["soksak-dev://cmd/bookmark.list", "soksak-dev://cmd/bookmark.list"]);
  });

  /** 없는 것을 조용히 성공으로 답하면 부른 쪽은 알림이 반응했다고 믿는다. */
  it("살아 있지 않은 알림은 이름을 달고 거절한다", () => {
    const table = loadTable();
    let code = null;
    try {
      table.notify_activate.answer({}, { handle: 9999 });
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("FRAMEWORK_NOTIFICATION_UNKNOWN");
  });

  /** 알림 클릭은 **밖에서 온 명령 실행**이다 — 딥링크와 같다. 그래서 이 창이 아니라 명령 표면의
   *  주인에게 간다: 창에 넘기면 그 창이 닫혔을 때 클릭이 유실되고, 창마다 다른 답이 된다. */
  it("클릭은 이 창이 아니라 주인에게 간다", () => {
    const table = loadTable();
    const sent = [];
    table.notify_show.answer(
      { deepLink: (u) => sent.push(u) },
      { title: "제목", body: "본문", extra: { deepLink: "soksak-dev://cmd/bookmark.list" } },
    );
    clicks.get("click")();
    expect(sent).toEqual(["soksak-dev://cmd/bookmark.list"]);
  });

  /** 실어 온 것이 명령 URI 인지는 코어가 답한다(아니면 `ran:false`). 여기서 고르면 그 규칙이
   *  프레임워크마다 한 벌이 되고, 두 껍데기가 같은 클릭에 다르게 반응한다. */
  it("클릭이 실어 온 것을 판정하지 않는다", () => {
    const table = loadTable();
    const sent = [];
    table.notify_show.answer({ deepLink: (u) => sent.push(u) }, { title: "제목", body: "본문" });
    clicks.get("click")();
    expect(sent).toEqual([undefined]);
  });

  /** 지원하지 않는 플랫폼에서 조용히 성공하면 부른 쪽은 알림이 떴다고 믿는다. */
  it("지원하지 않으면 이름을 달고 거절한다", () => {
    supported = false;
    const table = loadTable();
    let code = null;
    try {
      table.notify_show.answer({}, { title: "제목", body: "본문" });
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("FRAMEWORK_NOTIFICATION_UNSUPPORTED");
    expect(shown).toEqual([]);
  });
});
