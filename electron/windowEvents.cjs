// 창에 사건 하나를 배달하는 **한 자리**.
//
// 창으로 미는 길은 여럿이다(활동 원장 부채질·제어면 배달·앞으로 더). 저마다 자기 send 를
// 쓰면 죽은 창 판정과 통로 이름이 갈래마다 갈리고, 그 어긋남은 "한 갈래만 굶는다"로만
// 나타난다 — 오류 한 줄 없이.
//
// electron 을 require 하지 않는다. 창은 인자로 온다(스텁으로 그대로 검증된다).

/** 프리로드가 여는 전역 사건 통로(electron/preload.cjs). */
const EVENT_CHANNEL = "framework:event";

/**
 * 창 하나에 사건 하나. 반환 = 닿았는가.
 * 죽은 창·던진 창은 false 다 — 삼키면 유실이 성공으로 위장된다.
 */
function deliverEvent(win, event, payload) {
  try {
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    const wc = win.webContents;
    if (!wc || typeof wc.send !== "function") return false;
    wc.send(EVENT_CHANNEL, { event, payload });
    return true;
  } catch {
    return false;
  }
}

module.exports = { EVENT_CHANNEL, deliverEvent };
