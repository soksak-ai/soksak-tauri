// @vitest-environment node
// 앱 본체 원격 업데이트의 기준 — 없는 장치를 "최신"으로 답하지 않는다.
//
// 채널 게이트가 먼저다. dev·debug 홈의 본체는 로컬 빌드라 원격 조회 자체가 성립하지 않고,
// 그때의 available:false 는 "새 판이 없다"가 아니라 "이 채널은 원격을 안 본다"이다. 두 사실을
// 같은 모양으로 답하면 부른 쪽이 가릴 수 없어서 channel 을 함께 싣는다.
//
// release 채널은 이름을 달고 거절한다. 배선되지 않은 것을 available:false 로 답하면 그것은
// "최신이다"라는 거짓이고, 사용자는 오지 않을 업데이트를 영원히 기다린다.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const updater = requireCjs(join(ROOT, "frameworks/electron/native/updater.cjs"));
const { coreBuildOf } = requireCjs(join(ROOT, "frameworks/electron/cored.cjs"));

const ctx = (coreBuild) => ({ coreBuild: () => coreBuild });

describe("앱 본체 업데이트", () => {
  it("로컬 빌드 채널은 available:false 를 **채널과 함께** 답한다", () => {
    for (const build of ["dev", "debug"]) {
      const r = updater.update_check.answer(ctx(build));
      expect(r).toEqual({ available: false, channel: "local" });
    }
  });

  it("로컬 빌드 채널에서 설치는 이름을 달고 거절한다 — 조용한 성공이 없다", () => {
    expect(() => updater.update_apply.answer(ctx("dev"))).toThrow(
      /release/,
    );
  });

  it("release 채널은 '최신'이라 거짓말하지 않고 장치 부재를 이름으로 답한다", () => {
    let err;
    try {
      updater.update_check.answer(ctx("release"));
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("FRAMEWORK_UPDATER_ABSENT");
    // available:false 로 새어 나가지 않는다 — 그것이 이 검사의 전부다.
    expect(err?.message).not.toMatch(/available/);
  });

  it("빌드 축은 정체성에서 나온다 — 부르는 쪽마다 따로 세지 않는다", () => {
    expect(coreBuildOf("com.soksak.electron.dev")).toBe("dev");
    expect(coreBuildOf("com.soksak.electron.debug")).toBe("debug");
    expect(coreBuildOf("com.soksak.electron.app")).toBe("release");
    expect(coreBuildOf("com.soksak.tauri.dev")).toBe("dev");
  });
});
