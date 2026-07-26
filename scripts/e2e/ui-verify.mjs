// 창 구조 불변식 게이트 — 앱이 스스로 답한 결과를 그대로 판정한다.
//
// 판정 기준은 스크립트가 아니라 앱 안에 있다(ui.verify). 그래야 다음번에도, 사람이 손으로
// 확인할 때도 같은 기준이다 — 게이트마다 기준을 새로 적으면 기준이 게이트 수만큼 갈라진다.
//
// 여기서 지키는 것(전부 사용자 실측 결함에서 나왔다):
//   address.unique  한 주소가 둘로 풀리면 클릭·측정이 어느 패널로 갈지 알 수 없다.
//   rail.settled    여정이 끝났는데 빠지는 레일이 남으면 사이드바가 두 벌로 보인다.
//   slot.sized      보이는 슬롯의 크기가 0 이면 그 패널은 빈 화면이다.
//   motion.paired   화면과 위상의 시계가 갈라지면 이동 도중에 착지가 선언된다.
import process from "node:process";
import { openClient, must, workspaceWindows } from "./lib/client.mjs";

async function main() {
  const c = await openClient();
  try {
    const windows = await workspaceWindows(c);
    if (windows.length === 0) throw new Error("워크스페이스 창 없음");
    let broken = 0;
    for (const w of windows) {
      const r = must(await c.rpc("ui.verify", {}, w), `ui.verify(${w})`);
      for (const chk of r.checks ?? []) {
        console.log(`  ${chk.ok ? "✓" : "✗"} ${w} ${chk.name} — ${chk.detail}`);
        if (!chk.ok) broken += 1;
      }
    }
    if (broken > 0) throw new Error(`불변식 ${broken}건이 깨졌다`);
    console.log(`✓ ui-verify GREEN — 창 ${windows.length}개 모든 불변식 통과`);
  } finally {
    c.close();
  }
}
main().catch((e) => {
  console.error(`✗ ui-verify 실패: ${e?.message ?? e}`);
  process.exit(1);
});
