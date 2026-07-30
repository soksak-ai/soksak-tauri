// 못 채운 요구는 **적재를 막는다.**
//
// 등급 계약(unmetNeeds)도 있고 두 프레임워크가 자기 제공(engineProvision)도 채워 뒀는데, 그 둘을
// 대조하는 자리가 없었다. 계약을 적어 두고 읽지 않으면 그것은 없는 것과 같다 — 그 사이 네이티브
// 자식 표면이 없는 프레임워크에서도 그 표면을 전제한 플러그인이 그대로 적재되고, 화면에는
// "엔진 서피스 생성 실패"만 남았다(실측 2026-07-31, Electron).
//
// 조용히 막지 않는다. 무엇이 모자라서 빠졌는지 이름으로 남아야 다음 사람이 다시 조사하지 않고,
// 사용자도 "고장"이 아니라 "이 프레임워크에는 없는 표면"으로 읽는다.

import { unmetNeeds, type EngineProvision, type PluginManifest } from "@soksak-ai/plugin-spec";

/**
 * 이 프레임워크가 채우지 못하는 요구가 있으면 이름을 달고 거절한다.
 *
 * 요구가 없으면 아무것도 하지 않는다 — 규칙이 남의 표면까지 잡으면 곧 꺼진다.
 */
export function enforceEngineNeeds(
  manifest: PluginManifest,
  has: EngineProvision,
): void {
  const unmet = unmetNeeds(
    {
      requiresEngine: manifest.requiresEngine,
      requiresNativeChildWebview: manifest.requiresNativeChildWebview,
    },
    has,
  );
  if (unmet.length === 0) return;
  throw new Error(
    `${manifest.id}: 이 프레임워크가 못 채우는 요구가 있어 적재하지 않습니다 — ${unmet.join(", ")}`,
  );
}
