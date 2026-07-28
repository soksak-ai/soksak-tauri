// project_* — 어느 창이 어느 프로젝트 root 를 점유하는가.
//
// 갈래(window_·webview_…)가 아니지만 셸의 것이다. 등재 자체가 주장이다.
//
// **왜 프레임워크가 지는가.** 점유 지도는 `root → 창 라벨`이고, 그 수명이 곧 창의 수명이다.
// cored 가 쥐면 프레임워크가 재기동한 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다
// (cored 의 UNSERVED 가 적은 사유 그대로다). 창을 소유한 쪽이 지면 그 문제가 없다 — 창이
// 죽으면 그 창의 점유도 함께 죽는다.
//
// 이것이 없으면 프로젝트가 **조용히** 안 열린다: 디렉터리는 만들어지고, claim 이
// UNKNOWN_COMMAND 로 실패하고, 호출자가 그 실패를 값으로 바꿔 root 가 거부됨으로 분류되고,
// 화면은 "프로젝트 없음"이 된다(실측 2026-07-28).

const { frameworkError } = require("./error.cjs");

/** root → 창 라벨. 프로세스 안의 지도이고, 그것이 옳은 수명이다. */
const owners = new Map();

/** 죽은 창의 점유는 점유가 아니다 — 살아 있는 라벨만 소유자로 친다. */
function live(ctx) {
  const alive = new Set(ctx.labels());
  for (const [root, label] of owners) {
    if (!alive.has(label)) owners.delete(root);
  }
  return alive;
}

function needRoot(args) {
  const root = String(args.root ?? "").trim();
  if (!root) throw frameworkError("INVALID_ROOT", "root 가 필요하다");
  return root;
}

module.exports = {
  // 점유 시도. 실패는 예외가 아니라 **값**이다 — 호출자가 흐름을 가른다(다른 창이 쥐고 있으면
  // 그 창을 포커스한다). 예외로 만들면 그 분기가 오류 처리로 바뀐다.
  project_claim: {
    concept: "프로젝트 root 점유",
    source: "셸의 root→창 지도(수명이 창의 수명과 같다)",
    answer: (ctx, args) => {
      const root = needRoot(args);
      live(ctx);
      const label = ctx.window && ctx.labelOf(ctx.window);
      if (!label) throw frameworkError("NO_WINDOW", "부른 창을 짚지 못했다");
      const owner = owners.get(root);
      if (owner && owner !== label) return { ok: false, ownedBy: owner };
      owners.set(root, label);
      return { ok: true };
    },
  },

  // 해제는 **소유 창만** 한다. 아무 창이나 풀 수 있으면 점유가 점유가 아니다.
  project_release: {
    concept: "프로젝트 root 해제",
    source: "같은 지도",
    answer: (ctx, args) => {
      const root = needRoot(args);
      live(ctx);
      const label = ctx.window && ctx.labelOf(ctx.window);
      if (owners.get(root) === label) {
        owners.delete(root);
        return { released: true };
      }
      return { released: false };
    },
  },

  project_owners: {
    concept: "점유 목록",
    source: "같은 지도(죽은 창은 걸러진다)",
    answer: (ctx) => {
      live(ctx);
      return {
        owners: [...owners].map(([root, window]) => ({ root, window })),
      };
    },
  },
};
