// system.* — socket negotiation surface exposed through the command registry (single source of truth).
// system.hello: greet the app and read the socket protocol version, the oldest client protocol still
// served, and app identity. The transport answers this before the registry (so it replies even when the
// webview is wedged); the registry handler returns the same facts via the ipc_hello_info core command,
// so the command is discoverable and actually runs on every path.

import { engineProvision, framework, invoke } from "../framework";
import { tmsg } from "../i18n";
import { register } from "./registry";

export function registerSystemCatalog(): void {
  register("system.hello", {
    description:
      "Greet the app and read the socket protocol version, the oldest client protocol still served, and app identity (version, pid, start time, capabilities). A client sends this first to detect version skew before issuing commands. Also answered at the transport, so it replies even when the front is wedged.",
    triggers: { ko: "협상 핸드셰이크 헬로 인사 프로토콜 버전 스큐 호환 접속" },
    params: {},
    returns:
      "{ protocol, minClientProtocol, appVersion, identity, pid, startedAt, capabilities[] } — the socket protocol version, the oldest client protocol still served, and app identity.",
    message: (d) =>
      tmsg("msg.system.hello", {
        protocol: Number(d.protocol ?? 0),
        version: String(d.appVersion ?? ""),
      }),
    examples: ["hello"],
    // transport 즉답과 같은 hello_facts 를 내는 코어 커맨드로 위임 — 판 상수 단일 출처, 위조 복제 없음.
    handler: () => invoke("ipc_hello_info"),
  });

  // 끌 수 있는 이름이 없으면 하니스가 운영체제를 빌린다(`osascript ... to quit`) — 그래서
  // 만든다(A27). 자기 죽음은 죽은 뒤에 못 적으므로 프레임워크가 끄기 전에 남긴다.
  //
  // 한 홈에 두 앱이 서면 같은 이름을 둘이 든다. 이 명령은 **부른 창이 사는 앱**을 끈다 —
  // 창-지역으로 두는 이유가 그것이다(windowScoped 를 끄면 두 앱이 함께 죽는다).
  register("app.quit", {
    description:
      "Quit the app this window lives in. The other framework on the same home keeps running.",
    triggers: { ko: "앱 종료 끄기 quit" },
    params: {},
    danger: "destructive",
    returns: "{ ok }",
    message: () => tmsg("msg.app.quit"),
    examples: ["app.quit"],
    handler: () => {
      // 자기 파괴는 명령 응답을 먼저 cored 로 흘린 뒤 다음 task 에서 실행한다. 즉시 invoke 하면
      // Tauri 프로세스와 응답 통로가 함께 닫혀 호출자는 성공과 크래시를 구분할 수 없다.
      setTimeout(() => void invoke("app_quit"), 30);
      return { ok: true };
    },
  });

  register("app.environment", {
    description:
      "Read this app's compile-time core identity, isolated home, matching CLI name, build profile, updater channel, and explicitly selected development units.",
    triggers: { ko: "앱 환경 코어 빌드 홈 CLI 개발 유닛 모드" },
    params: {},
    // 답은 주인이 정한다 — 어느 창에서 돌든 같다(registry.ts windowScoped).
    windowScoped: false,
    returns:
      "{ coreBuild, identity, cli, home, buildProfile, updaterEnabled, unitMode, developmentUnits[] }",
    message: (d) =>
      tmsg("msg.app.environment", {
        core: String(d.coreBuild),
        mode: String(d.unitMode),
      }),
    examples: ["app.environment"],
    handler: () => invoke("app_environment"),
  });

  // 프레임워크가 무엇을 제공하는가 — 판정하는 쪽이 **물을 수 있어야** 한다.
  //
  // 같은 보증을 두 프레임워크가 다른 자리에서 지킨다. 브라우저 뷰가 살아 있다는 사실은 한쪽
  // 에서는 네이티브 자식 표면의 목록이고, 다른 쪽에서는 페이지 안 요소의 rect 다. 물을 자리가
  // 없으면 판정하는 쪽은 한쪽 모양을 정답으로 박아 두고, 다른 프레임워크에서는 그 검사가
  // 존재하지 않는 것을 찾다가 실패한다 — 기준이 틀린 게 아니라 재는 자리가 틀린 것이다.
  //
  // 능력 선언이지 이름 분기가 아니다. name 은 원장·진단에만 쓰고, 판정은 축(chromium·
  // nativeChildWebview)으로 가른다 — 프레임워크가 하나 더 늘어도 판정 코드는 그대로다.
  register("framework.provision", {
    description:
      "Read what this window's framework provides: adapter name, whether the engine is Chromium, and whether content views are native child webviews (as opposed to elements inside the page). Branch verification on these axes, never on the adapter name.",
    triggers: { ko: "프레임워크 능력 제공 축 네이티브 자식 웹뷰 엔진" },
    params: {},
    returns: "{ name, chromium, nativeChildWebview }",
    message: (d) =>
      tmsg("msg.framework.provision", {
        name: String(d.name ?? ""),
        views: String(d.nativeChildWebview ? "native" : "in-page"),
      }),
    examples: ["framework.provision"],
    handler: () => ({
      name: framework.name,
      chromium: engineProvision.chromium,
      nativeChildWebview: engineProvision.nativeChildWebview,
    }),
  });
}
