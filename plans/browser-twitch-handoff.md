# 인수인계 — "다른 탭을 클릭하면 브라우저가 반응한다"

작성 2026-07-25. 사용자가 며칠간 반복 지적한 미해결 증상의 조사 상태다. **해결되지 않았다.**

## 증상(사용자 표현 그대로)

브라우저와 무관한 곳(다른 탭·사이드바·에디터)을 클릭하면 브라우저가 반응한다 — "깜빡임",
"포커스 인/아웃 효과", "주소표시줄까지 움찔". 브라우저를 직접 만질 때 일어나면 불만이 없다.
간접 사건이 무관 표면에 영향을 주는 것이 문제의 본질이다.

## 이미 제거한 원인들 — 재조사 금지(전부 커밋·push 완료)

각 항목은 실측 근거와 게이트가 딸려 있다. 다시 파헤치지 말고, 게이트가 GREEN인지만 확인한다.

| 원인 | 처방 | 게이트 |
|---|---|---|
| 홀 계약이 pane-style 배경에 특이성으로 패배(전 홀 폐쇄) | pane 규칙에 `:not(.hole-slot)` | `visualEffectOwnership.test.ts`, slot-freeze E2E 홀 페인트 |
| 위상 하위 전체 선택자가 델타 0 요소까지 `animation`+`will-change` 부여(레이어 승격 요동) | `flipMoves`로 실이동 요소만 `.flip-move` | `visualEffectOwnership.test.ts`, slot-freeze E2E 합성 중립 |
| focus-dim `filter`에 160ms 전이(포커스마다 승격 레이어 재래스터) | 전이 제거(상시 승격은 무해) | 같은 정적 게이트 |
| 이중 dim 베일(슬롯 배경 + `::after`) → 동결 시 밝음 펄스 | `::after` 단일 베일 | `RailLinkOverlay.relation.test.tsx` |
| 동결 시 표면 hide/show 사이클(WK 재부착 1프레임 소실·CEF 재페인트) | 스탠드인이 곧 베일 — 표면 무접촉 | `slotFreeze.test.ts` |
| 유령 레일 주행(station float 오차·미해소 포커스의 0 붕괴) | ε 판정 + 미해소 포커스는 현 위치 유지 | `railMotion.test.ts`, `railPlacement.test.ts` |
| **레일 이주(flow)** — 레일이 포커스를 따라 이사하며 이웃을 밀어냄 | 모드 폐지(pin 전용, 레거시는 현 위치 정박으로 정규화) | `railPlacement.test.ts`, `catalogRailPosition.test.ts` |
| **근접 투영**(`projectFocusedPanelNearRail`) — 포커스 패널을 레일 옆으로 옮기는 레이아웃 교체 | 제거(`displayLayout = content.layout`, `projected: false`) | `sessions.railFocusNear.test.ts` |
| 모션 신호 브로드캐스트 → 무관 표면이 작업(생존 프로브·강제 재스냅) | 신호에 `views`(scope) 탑재, 무관 뷰는 즉시 반환. 종료는 전원 통지 + 참여 여부는 시작 에지에 기억 | `layoutMotion.test.ts` |
| 캐시 무효화(`lastRectRef=""`)가 same-rect 스킵 무력화 → 커밋마다 bounds 전송 | 무효화 제거(캐시는 마지막 전송값이라 stale 불가) | 런타임 계측(아래) |

관련 커밋: core `db25b165`~`f5fc4829`, browser-native `2e6a26f`, chromium `0215981`,
chromium-offscreen `8f999e3`. 원칙은 `docs/NATIVE-SURFACES.md` §2(기하 소유권·시각 효과
소유권)·§4.5·§4.6에 명문화됨.

## 수리 후 실측 — 이 축들은 배제됐다

- 무관 스왑 5회 중 브라우저 표면 작업 **0건**(`vis-trace`/`bounds-trace` 전무).
- 합성 네이티브 클릭(`webview.emitNative` mousedown/up)으로도 **0건**.
- 슬롯 rect·**네이티브 child NSView 프레임**(`window.layers`)·툴바 DOM(rect·opacity·filter·
  transform·animation) 전부 위상 전/중/후 불변.
- 사용자는 그럼에도 증상을 본다 → **측정 축이 아직 틀렸다.**

## 남은 후보 — 다음 세션의 작업 순서

1. **수리 후 새 녹화 판독이 최우선.** 사용자 화면이 유일한 진실이다. 절차:
   `ffmpeg -i <mov> -vf fps=30 f%04d.png` → 인접 프레임 크기 델타로 변화 구간 찾기 →
   그 구간 두 프레임을 `blend=all_mode=difference,eq=contrast=4`로 증폭해 **무엇이 이중상으로
   겹치는지** 본다(수리 전 녹화에서 이 방법이 "브라우저 콘텐츠 수평 이동"을 지목했다).
2. **레일 폭 미측정** — 내용 투영(파일트리↔북마크 교체) 시 레일 폭이 미세하게 달라지면
   이웃이 밀린다. `ui.measure win/<win>/chrome/rail/left` 의 `w` 를 포커스별로 소수점까지.
3. **분할 비율 소수점** — 슬롯 rect 정수 반올림 뒤에 소수 변화가 숨을 수 있다.
   `ui.measure` rect 를 `toFixed(3)` 로 비교(내 측정은 `int()` 로 잘랐다 — 이 함정 주의).
4. **플러그인 리렌더** — 리마운트가 아닌 리렌더로 툴바 내부가 재레이아웃되는가.
   툴바 **자식** 노드(back/forward/urlbar) rect 를 위상 중 대조.

## 측정 규율(반복해서 나를 속인 함정들)

- **파티클 노이즈**: 앱에 상시 벚꽃·물고기 장식이 떠다녀 픽셀 diff 가 매 프레임 변한다.
  픽셀 판정은 DOM 계기(`ui.measure`)로 교차검증해야 한다.
- **창 ID 갱신**: `screencapture -l<id>` 의 id 는 앱 재기동마다 바뀐다. 갱신 없이 캡처하면
  **조용히 0바이트**다. `scratchpad/winid.swift`(CGWindowList 덤프)로 매번 다시 얻는다.
- **정본 CLI**: `<machine-path>/soksak/core/frameworks/tauri/target/debug/sok-dev`. 다른 워크트리의
  sok-dev 를 쓰면 구 빌드로 판정한다.
- **파킹 슬롯**: 비활성 탭 슬롯은 `transform: matrix(...,-3600,0)` 로 화면 밖에 있다. 그
  상태의 측정은 무의미하니 대상 뷰를 먼저 활성화한다.
- **리로드 vs 신선 부팅**: `window.reload` 는 sessionStorage 를 살려 결함을 숨긴다.
  판정은 신선 부팅으로.

## 미해결 UI 부채(내 수리의 잔재)

핀 버튼(`left-rail-pin`)이 무반응이다 — flow 폐지로 토글 상대가 사라졌는데 버튼을 남겼다.
상태가 없어졌으면 버튼도 없어야 하고, 레일 이동은 그립 드래그(직접 조작)가 담당한다.
`src/App.tsx` 의 `toggleRailPin`·버튼 블록을 정리할 것.
