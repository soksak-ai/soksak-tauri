// 관측 배선의 상태 — registerCatalog() 말미에서 등록(catalog 분할 — catalogProjection 선례).
//
// 봉투의 degraded 는 요약이라 "절름거린다"까지만 말한다. 어느 축이 언제부터 어떻게인지는
// 세어야 알고, 셀 수 없으면 고쳤는지도 증명하지 못한다 — 그래서 묻는 자리를 따로 둔다.

import { tmsg } from "../i18n";
import { commandHealth, noteActivityPersist, register } from "./registry";
import { invoke } from "../framework";

export function registerHealthCatalog(): void {
  register("state.health", {
    description:
      "Report the liveness of the core's observation wiring: command registry size, execution trace sink, and activity hub publishing (attempts/ok/failed/consecutive/lastError/lastStampAt). Use this when responses look fine but nothing is being recorded.",
    triggers: { ko: "상태 진단 건강 관측 배선" },
    params: {},
    returns:
      "{ ready, commands:{registered,traceSinkInstalled,emitted,lastEmitAt}, activity:{attempts,ok,failed,consecutiveFailures,lastOkAt,lastFailAt,lastError,lastStampAt,healthy}, degradedAxes }",
    message: (d) =>
      tmsg("msg.state.health", {
        n: ((d.degradedAxes as unknown[]) ?? []).length,
      }),
    examples: ["state.health"],
    // 조회에 증상이 실리는 것(봉투 degraded)과 별개로, **묻는 자리**가 있어야 한다. 요약만으로는
    // 어느 축이 언제부터 어떻게 절름거리는지 셀 수 없고, 셀 수 없으면 고쳤는지도 증명 못 한다.
    handler: async () => {
      // Rust 쪽 카운터는 물어봐야 안다 — 프레임워크가 자기 프로세스의 영속 상태를 답한다.
      try {
        noteActivityPersist(
          (await invoke<Record<string, number>>("activity_persist_stats")) ?? {},
        );
      } catch {
        // 못 물어도 나머지 축은 답한다 — 한 축의 침묵이 진단 전체를 막지 않는다.
      }
      return commandHealth();
    },
  });

}
