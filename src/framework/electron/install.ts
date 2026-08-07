// 이 프레임워크가 코어 표면에 거는 것 전부 — 고른 어댑터만 불린다(contract.install).
//
// **거의 없다.** 이 프레임워크의 콘텐츠는 문서 안에 살기 때문에 갚을 빚이 없다: 자리의
// 자식으로 두면 자리와 함께 움직이고, 가리는 일은 평범한 쌓임으로 끝나며, 그 위의 마우스는
// 이 문서에 온다. 홀·스탠드인·레일 클립·네이티브 마우스는 여기서 걸지 않는다 — 그것은
// 콘텐츠가 문서 밖인 프레임워크의 물건이고, 여기서 돌면 멀쩡한 판을 비운다.
//
// 그러나 **재는 일은 빚이 아니라 의무다.** 표시 원장은 두 프레임워크가 같은 이름으로 답해야
// 하는 코어 계약이고, 여기서 안 걸면 그 축은 이 프레임워크에서 한 칸도 안 재진다.
import styles from "./styles.css?inline";
import { domHost } from "./contentViews";
import { adoptFrameworkStyles } from "../styles";
import { registerContentViewHost } from "../../lib/contentViews";
import { registerWindowResizeProbe } from "../../lib/windowResizeProbe";
import { activeElectronResizeProbe } from "./resizeProbe";
import { registerPresentationLedgerHost } from "../presentationLedger";
import {
  createDomPresentationLedger,
  documentDisplayFrameSource,
} from "./presentationLedger";
import { currentWindow, invoke } from "../index";

/** 이 창이 놓인 디스플레이의 표시 주기. 문서는 그 사실을 모르므로 프레임워크가 답한다. */
async function displayRefreshIntervalMs(): Promise<number> {
  const timing = await invoke<{ refreshIntervalMs: number }>("window_display_frame_timing");
  return Number(timing?.refreshIntervalMs);
}

export function installElectron(): void {
  registerContentViewHost(domHost);
  // window.resizeSequence의 수치 관측면. 요청 크기를 되풀이하지 않고 native presentation
  // 영수증과 현재 DOM/guest viewport를 같은 Electron 거래로 공개한다.
  registerWindowResizeProbe((request) => activeElectronResizeProbe().sample(request));
  // 표시 원장 — 문서 자신의 프레임 콜백이 표시 사건이고, 게스트는 그 프레임 안에 있다.
  registerPresentationLedgerHost(createDomPresentationLedger({
    source: documentDisplayFrameSource(displayRefreshIntervalMs),
    windowLabel: () => currentWindow().label,
  }));
  adoptFrameworkStyles("electron", styles);
}
