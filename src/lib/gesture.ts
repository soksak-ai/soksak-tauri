// 연속 제스처 — 표현과 동작을 한 자리에서 짝지운다.
//
// 드래그는 두 가지를 한다: 매 프레임 화면을 따라오게 하는 것(**표현**)과, 손을 뗀 자리를
// 남기는 것(**동작**)이다. 둘은 다르다 — 표현은 60fps 로 흐르고 동작은 한 번 일어난다.
//
// 그 차이가 이름 없이 흩어져 있으면 규칙이 설 수 없다. UI 가 store 를 직접 부르는 자리를
// 세는 게이트(ui-through-commands-scan)는 "이것이 표현인가 동작인가"를 기계로 가를 방법이
// 없어, 드래그 중 반영 하나를 위반으로 세거나 규칙 전체를 느슨하게 해야 했다.
//
// 그래서 짝을 강제한다. `preview` 를 쓰려면 `commit` 을 함께 적어야 한다(타입이 요구한다) —
// 표현만 있고 동작이 없는 제스처는 만들 수 없다. 그것이 정확히 오늘 고친 결함의 모양이다:
// 드래그가 화면은 바꾸는데 명령은 타지 않아 원장에 아무것도 안 남았다.
//
// 런타임은 얇다. 이 파일의 값은 **선언**에 있다: 표현이 어디이고 동작이 무엇인지가 코드에
// 적히고, 게이트가 그 선언을 읽는다.

export interface Gesture<T> {
  /**
   * 매 프레임 반영 — **표현**이다. 여기서 store 를 직접 부르는 것은 우회가 아니다:
   * 중간값을 명령으로 보내면 한 번의 드래그가 원장을 수십 줄로 덮는다.
   */
  preview: (value: T) => void;
  /**
   * 착지 — **동작**이다. 반드시 명령을 탄다. 부르는 쪽이 CLI·AI 와 같은 경로를 쓰고,
   * 그 사실이 원장에 남는다.
   */
  commit: (value: T) => void;
}

export interface RunningGesture<T> {
  /** 한 프레임의 값. 마지막 값은 착지에 쓰인다. */
  move: (value: T) => void;
  /** 손을 뗐다 — 마지막 값으로 commit 한다. 값이 한 번도 없었으면 아무 일도 없다. */
  end: () => void;
}

/**
 * 제스처를 연다. 착지값을 여기서 들고 있으므로 호출부가 그것을 따로 챙기지 않는다 —
 * 챙기는 자리가 흩어지면 "마지막 프레임 유실 = 스냅백"이 각자 다른 모양으로 재현된다.
 */
export function beginGesture<T>(g: Gesture<T>): RunningGesture<T> {
  let last: T | null = null;
  let landed = false;
  return {
    move(value) {
      last = value;
      g.preview(value);
    },
    end() {
      // 두 번 착지하지 않는다 — mouseup 과 정리 경로가 함께 부를 수 있다.
      if (landed || last === null) return;
      landed = true;
      g.commit(last);
    },
  };
}
