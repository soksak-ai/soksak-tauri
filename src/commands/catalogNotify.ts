// notify.* 알림 명령 — OS 알림(tauri-plugin-notification)을 command registry 로 노출(단일 진실).
// 스케줄러 reminder·발화 알림이 이 경로로 흐른다. 클릭→명령 실행은 딥링크(soksak[-env]://cmd/<name>)가
// 담당한다 — 데스크톱 알림은 per-notification 클릭 액션을 플랫폼이 지원하지 않으므로 딥링크가 그
// 자리를 메운다(코어 deeplink.rs on_open_url).

import { invoke } from "../framework";
import { tmsg } from "../i18n";
import { register } from "./registry";

export function registerNotifyCatalog(): void {
  register("notify.show", {
    description:
      "Show an OS desktop notification (title + body). Behaves like a push notification when the window is not focused. Clicking runs the deep link this notification carries — pass it as `deepLink` (soksak[-env]://cmd/<name>?<query>).",
    triggers: { ko: "알림 보내기 푸시 통지 데스크톱알림" },
    params: {
      title: { type: "string", description: "Notification title", required: true },
      body: { type: "string", description: "Notification body text", required: true },
      deepLink: {
        type: "string",
        description: "Deep link to run when the notification is clicked (soksak[-env]://cmd/<name>)",
        required: false,
      },
    },
    returns: "{ ok, handle }",
    message: () => tmsg("msg.notify.show"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['notify.show \'{"title":"배포 완료","body":"prod 배포가 끝났습니다"}\''],
    handler: async (p) => {
      if (typeof p.title !== "string" || typeof p.body !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "title·body 필요" };
      }
      // 클릭이 실어 갈 것을 그대로 넘긴다 — 명령 URI 인지는 코어가 답한다(아니면 `ran:false`).
      const r = await invoke<{ handle: number } | null>("notify_show", {
        title: p.title,
        body: p.body,
        extra: { deepLink: typeof p.deepLink === "string" ? p.deepLink : null },
      });
      // 주소를 돌려준다 — 없으면 띄운 알림을 되부를 길이 없다.
      return { ok: true, data: { handle: r?.handle ?? null } };
    },
  });

  // 알림 활성화 — **사람 손가락과 같은 문**이다.
  //
  // 활성화가 하는 일은 하나(실어 온 것을 주인에게 돌려준다)이고 프레임워크가 그 한 자리를
  // 가진다. 여기서 다시 적으면 두 길이 되고, 그때 이 명령이 통과해도 클릭은 죽어 있을 수 있다.
  //
  // 이것은 테스트용 뒷문이 아니다. 새 문을 내는 것이 아니라 이미 있는 문에 주소를 붙인 것이다
  // — 이름 없는 사건은 부를 수 없고, 부를 수 없는 것은 동작한다고 말할 수 없다.
  register("notify.activate", {
    description:
      "Activate a notification previously shown by `notify.show`, using its `handle`. Runs exactly what an OS click runs. | 알림 누르기 알림 활성화 클릭",
    triggers: { ko: "알림 누르기 알림 활성화" },
    params: {
      handle: { type: "number", description: "Handle returned by notify.show", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.notify.activate"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['notify.activate \'{"handle":1}\''],
    handler: async (p) => {
      if (typeof p.handle !== "number") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "handle 필요" };
      }
      await invoke("notify_activate", { handle: p.handle });
      return { ok: true };
    },
  });
}
