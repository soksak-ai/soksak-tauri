import { flushSync } from "react-dom";

/**
 * 레이아웃 상태 쓰기와 그 React DOM 커밋을 한 거래로 끝낸다.
 *
 * layout-motion 종료 소비자는 호출 직후 슬롯 rect를 최종값으로 읽는다. 단순 store flush는
 * 상태만 확정하고 concurrent React DOM은 뒤에 남길 수 있으므로 종료 사건 앞에서 이 경계를 쓴다.
 */
export function commitDomLayout(commit: () => void): void {
  flushSync(commit);
}
