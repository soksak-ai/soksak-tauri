// **번들은 IPC 를 지나지 않는다.**
//
// 부팅이 멈칫하는 자리는 플러그인 번들이다. 실측 2026-08-08: 34 건을 한 호출로 묶어도 818ms 가
// 그대로 남았다 — 왕복 수가 아니라 **옮기는 양**이 값이었다. 23.8MB 중 약 15MB 가 JSON 문자열로
// 직렬화돼 프로세스 경계를 건넌다. 묶는 것으로는 그 비용이 안 준다.
//
// 웹뷰는 파일을 직접 읽을 수 있다. 프레임워크마다 그 주소를 만드는 방법이 다를 뿐이고, 그것은
// 계약이 답할 일이다 — 코어는 주소를 받아 `fetch` 한다. 그러면 번들은 엔진의 자원 적재 경로로
// 들어오고 IPC 는 한 글자도 나르지 않는다.
//
// 옛 경로는 남기지 않는다. 두 벌이 되면 어느 쪽이 도는지 값으로 모른다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

describe("번들 적재 경로", () => {
  it("계약이 자원 주소를 답한다", () => {
    expect(read("../framework/contract.ts")).toMatch(/assetUrl\(path: string\): string/);
  });

  it("두 프레임워크가 모두 채운다 — 한쪽만 답하면 부팅 비용이 프레임워크마다 갈린다", () => {
    expect(read("../framework/tauri/index.ts")).toContain("assetUrl");
    expect(read("../framework/electron/index.ts")).toContain("assetUrl");
  });

  it("코어는 주소를 받아 직접 가져온다", () => {
    const source = read("./plugins.ts");
    expect(source).toMatch(/fetch\(assetUrl\(/);
  });

  // 두 벌이 남으면 어느 쪽이 도는지 값으로 모른다. 번들의 옛 경로는 지운다.
  //
  // 매니페스트(`plugin.json`)는 남는다 — 같은 부름이 아니다. 수 KB 짜리이고, 무엇보다 그 읽기는
  // **경로 판정**을 지난다(`expand` + `project_root_verdict`). dev 적재는 사용자가 준 임의
  // 경로를 받으므로 그 판정이 곧 경계다. 크기가 값이 아닌 자리에서 판정을 버릴 이유가 없다.
  it("번들을 IPC 로 나르는 옛 경로가 남아 있지 않다", () => {
    const source = read("./plugins.ts");
    expect(source).not.toContain("read_text_files");
    // 번들은 `manifest.entry` 로 지목된다 — 그 이름이 IPC 읽기와 같은 줄에 있으면 옛 경로다.
    const ipcReads = source.split("\n").filter((line) => line.includes('invoke<{ content: string }>("read_text_file"'));
    const bundleReads = source
      .split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ i }) => source.split("\n").slice(i, i + 3).join(" ").includes("manifest.entry"))
      .filter(({ line }) => line.includes('"read_text_file"'));
    expect(bundleReads).toEqual([]);
    // 매니페스트 읽기는 남아 있어야 한다 — 없으면 경로 판정을 잃은 것이다.
    expect(ipcReads.length).toBeGreaterThan(0);
  });

  it("앱 표면에도 그 명령이 남아 있지 않다", () => {
    const lib = readFileSync(
      resolve(__dirname, "../../frameworks/tauri/src/lib.rs"), "utf8",
    );
    expect(lib).not.toContain("read_text_files");
  });
});
