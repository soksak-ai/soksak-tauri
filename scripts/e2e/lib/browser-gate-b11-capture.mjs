import fs from "node:fs";
import { PNG_HEADER_BYTES, readPngSize } from "./png.mjs";

/**
 * full capture 산출물의 실측 크기.
 *
 * 엔진이 답한 문서 크기가 아니라 파일이 실제로 담은 IHDR 정수다. 캡처 요청에 쓴 문서 크기를
 * 그대로 되돌려준 영수증은 "문서 전체를 담았다"를 증명하지 못한다 — 자기 자신과 맞대기 때문이다.
 *
 * 픽셀은 풀지 않는다. 마커·색·성분 판정은 여전히 사람의 시각 검토가 소유하고, 여기서 읽는 것은
 * 파일이 헤더로 스스로 밝힌 크기뿐이다.
 *
 * 배율은 파이프라인마다 다르므로(WebKit PDF 1x, Electron 타일 합성 device pixel) 여기서
 * 정규화하지 않는다. 그 해석은 판정이 소유한다.
 *
 * 읽지 못하면 null 이다 — 던지지 않는다. 산출물을 못 읽었다는 사실은 판정이 이름으로 내야 하고,
 * 남은 게이트의 측정을 끊어서는 안 된다.
 */
export function measureCapturedImage(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const head = Buffer.alloc(PNG_HEADER_BYTES);
    const read = fs.readSync(handle, head, 0, PNG_HEADER_BYTES, 0);
    const size = read === PNG_HEADER_BYTES ? readPngSize(head) : null;
    return { capturedWidth: size?.w ?? null, capturedHeight: size?.h ?? null };
  } catch {
    return { capturedWidth: null, capturedHeight: null };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}
