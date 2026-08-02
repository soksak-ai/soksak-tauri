// 명령이 **대상 때문에** 거절하는 모양 — 카탈로그가 공유한다.
//
// 카탈로그마다 다시 적으면 같은 사실이 여러 벌이 되고 그중 하나만 고쳐지는 날이 온다
// (실측 2026-08-02: catalog.ts 와 catalogPlugins.ts 에 글자까지 같은 것이 각자 있었다).
//
// 등록부의 `unknownCommand` 와 헷갈리지 않는다: 그것은 **명령 이름**을 모른다는 말이고
// 이것은 명령은 아는데 **그 대상**이 없다는 말이다. 두 사실이 한 이름을 쓰면, 부른 쪽은
// "오타를 냈나"와 "그런 탭이 없나"를 가를 수 없다.

export const notFound = (what: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: what,
});
