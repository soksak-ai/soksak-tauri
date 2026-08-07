// framework.* — 앱이 지금 어느 프레임워크(Tauri·Electron) 위에서 도는가를 밖에서 읽는 표면.
//
// 셸이 아니다 — 그 말은 로그인 셸(zsh·bash)의 것이고 이 저장소는 PTY·터미널을 핵심으로
// 다룬다(login_shell.rs·--login-shell·shell_which). platform 도 아니다 — 그것은 OS 다.
//
// 프레임워크는 어댑터 뒤에 있고(src/framework), 그 경계가 있어 앱 코드는 프레임워크를 모른다. 그러나 진단·
// 하니스·원장은 알아야 한다 — "어느 프레임워크에서 난 일인가"에 답하지 못하면 두 프레임워크의 증거가 한
// 더미로 섞인다. 그래서 이름은 계약(AppFramework.name)이 이미 들고 있고, 여기서 명령으로 낸다.
//
// 능력은 **존재 여부만** 읽는다. 미구현 능력은 부르는 순간 이름을 달고 throw 하도록 설계돼
// 있으므로(어댑터의 unimplemented), 조회가 능력을 부르면 조회 자체가 앱을 흔든다.

import { framework } from "../framework";
import { titlebarProvisionBreaches } from "../framework/titlebarProvision";
import { tmsg } from "../i18n";
import { register } from "./registry";

/** 계약 능력의 이름 — 중첩 묶음(app·path·dialog·notification·deepLink)은 점 경로로 편다.
 *  값은 읽기만 한다(호출 금지). name 은 능력이 아니라 정체성이라 빠진다. */
function capabilityNames(framework: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(framework)) {
    if (key === "name") continue;
    const value = framework[key];
    if (typeof value === "function") out.push(key);
    else if (value && typeof value === "object") {
      for (const sub of Object.keys(value as object)) out.push(`${key}.${sub}`);
    }
  }
  // 결정적 순서 — 밖에서 원장끼리 대조할 때 순서가 흔들리면 차이가 거짓으로 보인다.
  return out.sort();
}

export function registerFrameworkCatalog(): void {
  register("framework.info", {
    description:
      "Read which app framework this window actually runs on (the resolved adapter, e.g. tauri or electron) and which contract capabilities that adapter exposes. Capability names are reported by presence only — nothing is invoked, because an unimplemented capability throws when called. Use when diagnosing an incident, driving a harness, or stamping a ledger entry with the framework it came from.",
    triggers: { ko: "프레임워크 어댑터 플랫폼 활성 런타임 진단 능력 어느프레임워크" },
    params: {},
    returns:
      "{ framework, capabilities[], titlebarComposition, titlebarBreaches[] } — the active adapter name, the contract capability names it exposes (nested groups flattened as group.member), this framework's own declaration about window-control (traffic light) composition, and the calls it declared as provided yet refused.",
    message: (d) =>
      tmsg("msg.framework.info", {
        framework: String(d.framework ?? ""),
        n: Array.isArray(d.capabilities) ? d.capabilities.length : 0,
      }),
    examples: ["framework.info"],
    handler: () => ({
      framework: framework.name,
      capabilities: capabilityNames(framework as unknown as Record<string, unknown>),
      // 신호등 합성은 존재 여부만으로는 못 읽는다 — 없는 축은 **사유**가 답이다. 그 선언을
      // 판정이 읽어야 프레임워크 이름으로 가르는 자리가 사라진다.
      titlebarComposition: framework.titlebarComposition,
      // 선언과 행동이 갈린 자리. 비어 있음과 안 잼은 다르므로 항상 싣는다(빈 배열도 답이다).
      titlebarBreaches: titlebarProvisionBreaches(),
    }),
  });
}
