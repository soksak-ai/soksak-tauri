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
 * 엔진 모델 사이드카를 소비하는가 — **그 자체가 표면 요구다.**
 *
 * docs/SIDECARS.md §1 의 모델 표가 그렇게 적어 뒀다: engine = in-process dylib, 그리고 그
 * Surface 칸은 "renders into pane surfaces (NSView)". 표면 없는 engine 은 그 정의상 없다.
 *
 * 그래서 저자에게 `requiresNativeChildWebview: true` 를 손으로 또 적게 하지 않는다. 두 벌은
 * 갈리는 순간까지 조용하고, 실제로 갈렸다(실측 2026-07-31: 엔진을 쓰면서 아무 요구도 안 적은
 * 플러그인이 Electron 에서 그대로 적재되어 "엔진 서피스 생성 실패"만 남겼다).
 *
 * 가르는 것은 **소비 모델**이다. 같은 `sidecars[]` 를 두 모델이 공유하므로 그 배열만으로는
 * 못 가른다.
 *
 * 권한으로 가르지 않는다. 권한은 **열어 둔 문**이지 지나간 자국이 아니다 — 실측(2026-07-31):
 * soksak-plugin-workflow 는 `sidecar` 권한을 과선언했지만 실제로는 app.process 만 쓰는 서비스
 * 모델이고, 권한으로 가른 첫 판은 그 헤드리스 플러그인을 Electron 에서 통째로 떨궜다.
 *
 * 서비스 모델의 증거는 `service` 선언이다 — spec 이 그 자리를 그 뜻으로 이미 두고 있다
 * (`service: { sidecar, interface }`). 그것이 있으면 이 플러그인의 사이드카 소비는 프로세스
 * 스폰이고, 표면을 요구하지 않는다.
 */
function consumesEngineSidecar(manifest: PluginManifest): boolean {
  const sidecars = manifest.sidecars ?? [];
  if (sidecars.length === 0) return false;
  if (manifest.service !== undefined) return false;
  const permissions: readonly string[] = manifest.permissions ?? [];
  return permissions.includes("sidecar");
}

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
      // 적힌 것과 **파생된 것**의 합집합. 파생이 없으면 저자의 기억이 유일한 방어가 된다.
      requiresNativeChildWebview:
        manifest.requiresNativeChildWebview || consumesEngineSidecar(manifest),
    },
    has,
  );
  if (unmet.length === 0) return;
  throw new Error(
    `${manifest.id}: 이 프레임워크가 못 채우는 요구가 있어 적재하지 않습니다 — ${unmet.join(", ")}`,
  );
}
