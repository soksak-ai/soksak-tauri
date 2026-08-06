// Electron WebContents frame subscription broker.
//
// beginFrameSubscription/endFrameSubscription은 구독 handle을 반환하지 않는 WebContents 전역
// 손잡이다. 소비자가 각각 직접 부르면 마지막 begin/end가 다른 소비자의 관측을 덮거나 끊는다.
// 이 broker만 native 손잡이를 소유하고, 소비자는 idempotent lease로 presentation을 공유한다.

function namedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validContents(contents) {
  return !!contents &&
    (typeof contents.isDestroyed !== "function" || !contents.isDestroyed()) &&
    typeof contents.beginFrameSubscription === "function" &&
    typeof contents.endFrameSubscription === "function";
}

function createFrameSubscriptionBroker({ onListenerError = () => {} } = {}) {
  if (typeof onListenerError !== "function") {
    throw new TypeError("frame subscription listener error handler가 함수가 아니다");
  }
  const states = new WeakMap();

  function stateFor(contents) {
    let state = states.get(contents);
    if (!state) {
      state = {
        generation: 0,
        sequence: 0,
        active: false,
        leases: new Map(),
      };
      states.set(contents, state);
    }
    return state;
  }

  function acquire(contents, sink) {
    if (!validContents(contents)) {
      throw namedError(
        "PRESENTATION_UNAVAILABLE",
        `WebContents ${contents?.id ?? "?"}의 presentation 사건을 구독할 수 없다`,
      );
    }
    if (typeof sink !== "function") {
      throw new TypeError("frame subscription sink가 함수가 아니다");
    }

    const state = stateFor(contents);
    const token = Symbol("frame-subscription-lease");
    state.leases.set(token, sink);

    if (!state.active) {
      state.active = true;
      state.generation += 1;
      state.sequence = 0;
      const subscriptionGeneration = state.generation;
      try {
        // 항상 full frame을 받는다. broker 소비자 하나가 dirty frame만 요구한다고 native
        // 구독을 바꾸면 이미 붙은 소비자의 기하 증명이 깨진다.
        contents.beginFrameSubscription(false, (image, dirtyRect) => {
          if (!state.active || state.generation !== subscriptionGeneration) return;
          state.sequence += 1;
          const event = Object.freeze({
            image,
            dirtyRect,
            subscriptionGeneration,
            sequence: state.sequence,
          });
          for (const listener of [...state.leases.values()]) {
            try {
              listener(event);
            } catch (error) {
              onListenerError(error, contents);
            }
          }
        });
      } catch (error) {
        state.active = false;
        state.leases.delete(token);
        throw error;
      }
    }

    let released = false;
    return {
      contentsId: Number(contents.id),
      subscriptionGeneration: state.generation,
      release() {
        if (released) return;
        released = true;
        state.leases.delete(token);
        if (state.leases.size !== 0 || !state.active) return;
        // 먼저 닫아 늦게 들어온 이전 callback을 차단한 뒤 native 구독을 끝낸다.
        state.active = false;
        contents.endFrameSubscription();
      },
    };
  }

  return {
    acquire,
    status(contents) {
      const state = states.get(contents);
      return state
        ? {
            active: state.active,
            generation: state.generation,
            sequence: state.sequence,
            leases: state.leases.size,
          }
        : { active: false, generation: 0, sequence: 0, leases: 0 };
    },
  };
}

module.exports = { createFrameSubscriptionBroker };
