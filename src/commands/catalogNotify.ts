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
    returns: "{ ok }",
    message: () => tmsg("msg.notify.show"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['notify.show \'{"title":"배포 완료","body":"prod 배포가 끝났습니다"}\''],
    handler: async (p) => {
      if (typeof p.title !== "string" || typeof p.body !== "string") {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: "title·body 필요" };
      }
      // 클릭이 실어 갈 것을 그대로 넘긴다 — 명령 URI 인지는 코어가 답한다(아니면 `ran:false`).
      await invoke("notify_show", {
        title: p.title,
        body: p.body,
        extra: { deepLink: typeof p.deepLink === "string" ? p.deepLink : null },
      });
      return { ok: true };
    },
  });
}
