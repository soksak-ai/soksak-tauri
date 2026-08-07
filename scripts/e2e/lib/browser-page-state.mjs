/**
 * B11이 판정하는 페이지 상태를 페이지에서 읽어 오는 probe를 한 자리에서 소유한다.
 * 하니스가 실제로 보내는 eval 본문이 여기에만 있어야 짝 테스트가 같은 JS를 실행해
 * 축 누락을 잡는다. 문자열을 호출부에 다시 적으면 검사받지 않는 사본이 생긴다.
 */
export function fullCaptureDocumentProbeJs() {
  return "return { y:scrollY, viewport:{w:innerWidth,h:innerHeight}, document:{w:Math.max(innerWidth,document.documentElement.scrollWidth),h:Math.max(innerHeight,document.documentElement.scrollHeight)} };";
}
