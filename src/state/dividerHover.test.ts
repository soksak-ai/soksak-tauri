// divider hover 는 "있음"만 말하는 소스(네이티브 로컬 모니터의 MouseMoved)에서 온다. 그래서
// 들어가는 에지만 있고 나오는 에지가 없었다 — 포인터가 창 밖으로 나가면 이벤트가 끊기고,
// 끊긴 것과 "그 자리에 멈춰 있다"가 구별되지 않아 강조가 영원히 남는다.
//
// 실측된 결과(2026-07-26): accent 세로선이 창 본문 전체 높이로 브라우저 표면들을 가로지른 채
// 굳었다. ui.hit 이 그 자리에서 `egroup-divider` s1:0 을 반환했고, rect(985.4, 82, 6, 997)가
// 네이티브 강조바 프레임과 정확히 같았다 — DOM 강조와 네이티브 바가 같은 굳은 상태의 두 얼굴.
//
// 여기서 고정하는 것은 상태의 대칭이다: 세팅과 해제가 짝을 이룬다.
import { beforeEach, describe, expect, it } from "vitest";
import { useDividerHover } from "./dividerHover";

describe("dividerHover — 들어가면 나올 수 있어야 한다", () => {
  beforeEach(() => useDividerHover.setState({ key: null }));

  it("hover 로 켜지고 null 로 꺼진다", () => {
    useDividerHover.getState().set("s1:0");
    expect(useDividerHover.getState().key).toBe("s1:0");
    useDividerHover.getState().set(null);
    expect(useDividerHover.getState().key).toBeNull();
  });

  it("같은 값 재세팅은 상태 객체를 바꾸지 않는다 — hover 이동마다 리렌더하지 않기 위해", () => {
    useDividerHover.getState().set("s1:0");
    const before = useDividerHover.getState();
    useDividerHover.getState().set("s1:0");
    expect(useDividerHover.getState()).toBe(before);
  });

  it("이미 꺼진 상태에서 다시 끄는 것도 무해하다 — 부재 신호는 여러 경로로 온다", () => {
    // 코어는 창 resignKey 와 앱 resignActive 양쪽에서 native-mouseleave 를 낸다. 둘 다
    // 도착할 수 있으므로 해제는 멱등이어야 한다.
    const before = useDividerHover.getState();
    useDividerHover.getState().set(null);
    expect(useDividerHover.getState()).toBe(before);
    expect(useDividerHover.getState().key).toBeNull();
  });
});
