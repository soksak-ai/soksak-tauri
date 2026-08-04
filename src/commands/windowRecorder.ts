import { invoke } from "../framework";

export type WindowRecordRequest = {
  dir: string;
  frames: number;
  intervalMs: number;
};

/**
 * 프레임워크 중립 창 녹화 정책.
 *
 * 껍데기는 한 프레임의 픽셀만 제공한다. 프레임 수, 간격, 파일 이름은 공통 명령 계층이
 * 소유해야 Electron과 Tauri가 같은 자동화 계약을 답한다. 호출자가 정한 유한 횟수만 실행하며
 * 상태를 기다리거나 재시도하지 않는다.
 */
export async function recordWindowFrames({
  dir,
  frames,
  intervalMs,
}: WindowRecordRequest): Promise<number> {
  let captured = 0;
  for (let i = 0; i < frames; i += 1) {
    const started = performance.now();
    const png = await invoke<string>("plugin:webview-capture|snapshot_region", {});
    await invoke("write_file_base64", {
      path: `${dir}/f${String(i).padStart(4, "0")}.png`,
      base64: png,
    });
    captured += 1;
    const rest = intervalMs - (performance.now() - started);
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
  }
  return captured;
}
