// 이 프레임워크가 코어 표면에 거는 것 전부 — 고른 어댑터만 불린다(contract.install).
//
// **거의 없다.** 이 프레임워크의 콘텐츠는 문서 안에 살기 때문에 갚을 빚이 없다: 자리의
// 자식으로 두면 자리와 함께 움직이고, 가리는 일은 평범한 쌓임으로 끝나며, 그 위의 마우스는
// 이 문서에 온다. 홀·스탠드인·레일 클립·네이티브 마우스는 여기서 걸지 않는다 — 그것은
// 콘텐츠가 문서 밖인 프레임워크의 물건이고, 여기서 돌면 멀쩡한 판을 비운다.
import styles from "./styles.css?inline";
import { domHost } from "./contentViews";
import { adoptFrameworkStyles } from "../styles";
import { registerContentViewHost } from "../../lib/contentViews";
import { registerWindowResizeProbe } from "../../lib/windowResizeProbe";
import { activeElectronResizeProbe } from "./resizeProbe";

export function installElectron(): void {
  registerContentViewHost(domHost);
  // window.resizeSequence의 수치 관측면. 요청 크기를 되풀이하지 않고 native presentation
  // 영수증과 현재 DOM/guest viewport를 같은 Electron 거래로 공개한다.
  registerWindowResizeProbe((request) => activeElectronResizeProbe().sample(request));
  adoptFrameworkStyles("electron", styles);
}
