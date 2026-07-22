# 사이드바 투영 스펙 (Sidebar Projection Spec) v1

상태: 방향 확정 스펙 (2026-07-21, 6렌즈 53에이전트 적대검증 반영).
구현이 완료된 부분은 docs/SIDEBAR.md 와 @soksak-ai/plugin-spec 에 현재시제로 이행하고, 이 문서는 결정의 근거로 남는다.

## 0. 테제 — AI 시대의 IDE

VSCode류는 "에디터가 주인, 나머지는 부속"인 구조다. AI 시대의 IDE는 다르다: 사람은 에이전트를 컨트롤하고 결과를 확인한다. 필요한 것은 뼈대(skeleton)와 무한 분할이다.

문제는 도구다. 터미널은 사이드바가 없어 분할이 자연스럽지만, ERD·kanban·에디터 같은 도구는 자체 사이드바를 품고 있어 분할 패널에 들어가는 순간 사이드바가 패널마다 중복된다.

해법: **사이드바를 도구에서 분리해 글로벌 레일로 투영한다.** 화면은 항상 `[좌 레일 | 무한분할 콘텐츠 | 우 레일]`이고, 결부된 콘텐츠 뷰의 사이드바가 레일에 투영된다.

## 1. 공리

**A1. 사이드바 필수.** 모든 콘텐츠 뷰는 좌 사이드바 선언을 가진다. 우 사이드바는 선택이다(없을 수 있다). "사이드바 없는 도구"는 존재하지 않는다 — 아직 정의되지 않았을 뿐이다. 적용 대상과 예외는 기계검사 가능해야 한다(§3.1).

**A2. 흡수와 투영.** 도구는 사이드바를 내부에 렌더링하지 않는다. 사이드바는 글로벌 레일에 투영되고, 각 스페이스는 하나의 콘텐츠 뷰 결부를 소유한다. 패널 포커스는 레일 위치만 바꾸며 투영 콘텐츠를 교체하지 않는다. 좌·우 대칭 규칙이다.

**A3. 3화면 정형.** 창의 레이아웃은 `[좌 레일 | 콘텐츠 | 우 레일]`로 고정한다. 분할은 콘텐츠에서만 일어나며 재귀·무제한이다. 레일 안에서 콘텐츠 분할을 만들지 않는다. 좌 레일이 **어느 세로 라인에 서는가**(가로 위치)는 §5.1 위치 모드(FLOW/PIN)가 정한다 — 정형 자체와 R8 불가침은 그대로다.

**A4. 공유 참조.** 여러 도구가 같은 사이드바를 참조할 수 있다. 초기 확정: 터미널·에디터·media-viewer → 파일트리, 브라우저 → 즐겨찾기(bookmarks). 결부가 이동해도 해소된 instanceKey가 같으면 레일은 전환되지 않고 상태가 보존된다.

**A5. 투명한 뼈대.** 레일은 코어가 소유한 계약 뼈대다. 코어는 프레임과 템플릿만 제공하며 레일 내용을 하드코딩하지 않는다. 템플릿은 형태의 어휘다 — 단일, 분할(스택), 탭을 조합할 수 있고, 어휘의 소유자는 코어다. 내용은 전부 플러그인 주입이다. 특정 플러그인 id를 코어가 기본값으로 지명하는 것도 하드코딩이다 — 금지.

**A6. 배치 권위와 배선.** "좌/우/중앙에 가야만 한다"는 플러그인의 정적 배치 계약은 존재하지 않는다. 배선된 등록 표면이 가능성을 정하고(`+` 메뉴 등록 = 중앙 전용), 실제 배치(어디에 어떻게)는 중앙(코어 콘텐츠 평면의 배치 엔진)이 컨트롤한다. 영향 경로는 두 채널로 분리된다:
- UI 암묵 경로(레일의 클릭·기본 라우팅): 결부 문맥(결부 뷰가 속한 그룹)에 한정.
- command 명시 경로: 계약-핀(consumes) 하에서 무제한. 교차 도구 동작(터미널→데몬→다른 패널의 브라우저)은 전부 이 경로로 흐른다.
UI 투영은 특권 채널이 아니라 배선 위의 소비자다.

**A7. 존재도 배선.** 등록 표면에 배선되지 않으면 뷰가 없을 수 있고 그것은 합법이다(command/데몬 제공자). A1의 적용 대상은 배선되어 존재하게 된 콘텐츠 뷰다.

**A8. 결부는 스페이스 소유의 명시 상태다.** 좌–중앙–우 연결은 DOM 포커스에서 파생하지 않는다.
- 각 `ContentArea`는 `railBindingViewId` 하나를 소유한다. 처음 결부된 생존 콘텐츠 뷰가 정본이며 스냅샷에 영속된다.
- `activeGroup`·`activeView`는 FLOW의 위치와 focusHistory만 갱신한다. 그룹·탭 전환은 투영 콘텐츠를 교체하지 않는다.
- 레일 상호작용은 결부·패널 포커스·FLOW 위치를 바꾸지 않는다.
- 결부 뷰가 닫히면 같은 스페이스의 focusHistory로 승계한다(R6).

**A9. 인스턴스 축.** 사이드바 참조는 인스턴스 정책을 선언한다:
- `shared`: 프로젝트 안에서 단일 인스턴스. instanceKey = (projectId, 해소된 ref). (파일트리, 북마크)
- `per-view`: 결부 콘텐츠 뷰별 인스턴스. instanceKey = (projectId, 해소된 ref, viewId). (db-studio 내비게이터, astryx 구조 트리)
교차 플러그인 참조는 계약 주소로만 한다(§3.1) — 이름-핀 금지. 참조 해소 실패(계약 미구현·비활성·consumes 위반) 또는 선언 부재 시 해당 슬롯은 강등된다 — 빈 슬롯 + 안내. 스펙 위반이 아니라 정의된 상태다.

**A10. selection 소유권과 흡수 판별 기준.**
- selection은 콘텐츠 뷰가 소유하는 상태 `{type, ref, meta?}`다. 레일 뷰는 소유하지 않는다 — 결부 뷰의 selection을 구독해 오버레이(하이라이트)로 그리고, 클릭으로 결부 뷰의 selection에 발행한다.
- 흡수 판별 기준: 패널 분할 시 **중복이 낭비인 것**(항해·검사 = 선택의 표면)만 레일로 흡수한다. **중복이 의미인 것**(콘솔·출력·상태바·툴바 = 인스턴스의 산출물)은 도구 내부에 남는다. 상단 툴바·하단 패널은 정형화 대상이 아니다.

## 2. 용어

| 용어 | 정의 |
|---|---|
| 레일(rail) | 창의 좌/우 글로벌 사이드바 영역. 코어 소유의 프레임. 셸 구조상 프로젝트별 인스턴스 |
| 결부(binding) | 레일이 어느 콘텐츠 뷰의 선언을 투영하는가의 관계. 스페이스가 하나를 소유 |
| 결부 뷰 | 스페이스의 `railBindingViewId`가 가리키는 생존 콘텐츠 뷰(View) |
| 결부 문맥 | 결부 뷰가 속한 그룹(ViewGroup). UI 암묵 경로의 영향 범위 |
| 스페이스 | ContentArea — 프로젝트 안의 독립 분할 그리드(콘텐츠 탭) |
| 투영(projection) | 결부 뷰의 사이드바 선언을 레일 슬롯에 해소·렌더하는 것 |
| 투영 슬롯 | 레일에서 결부에 따라 내용이 바뀌는 영역 |
| 핀(pin) | 사용자가 레일에 고정한 참조(ref). 결부와 무관하게 유지 |
| 상주형(resident) | 레일이 곧 집인 뷰(mailbox, clipboard, activity 등). 핀의 대상 |
| instanceKey | 투영 뷰 인스턴스의 동일성 키. shared=(project, ref), per-view=(project, ref, viewId) |
| intent | 레일이 결부 문맥에 발행하는 요청(열기 등). 배치는 중앙이 결정 |

## 3. 계약 (@soksak-ai/plugin-spec 확장)

### 3.1 sidebar 선언

`contributes.views[]`의 `content` placement 뷰와 `contributes.fileViewers[]`에 `sidebar` 필드를 신설한다.

```jsonc
{
  "id": "term",
  "placements": ["content"],
  "sidebar": {
    "left": [
      { "contract": "soksak-spec-plugin-sidebar-file-tree", "range": "^0.0.1", "view": "tree", "instance": "shared" },
      { "ref": "self.blocks", "instance": "per-view" }    // 선택: 스택의 둘째 칸
    ],
    "right": [],                                           // 우는 선택 — 빈 배열/생략 = 없음
    "template": "stack"                                    // 슬롯 2개 이상일 때: "stack"(기본) | "tabs"
  }
}
```

- 참조 형태는 둘뿐이다:
  - `ref: "self.<viewId>"` — 자기 플러그인의 rail 뷰.
  - `{ contract, range, view }` — **계약 주소**. `<pluginId>.<viewId>` 이름-핀은 금지다(C3 L1). 코어가 계약의 활성 구현체로 해소하고(기존 viewContract/resolveContractImplementer와 동일 기계), `view`는 구현체에서 열 뷰 id다 — 프로그램의 viewContract+view 페어링과 동일 패턴으로 뷰 id는 계약 관례의 일부이며 소비자가 선언한다. 제공자(file-tree, bookmarks)는 해당 계약을 `implements`로 발행한다.
- `left`: 1개 이상 필수(A1). `right`: 0개 이상.
- 템플릿 어휘(stack·tabs)는 코어 소유(A5) — 확장은 코어 버전업으로만. 플러그인의 임의 레이아웃 주입 금지.
- `instance`: `"shared" | "per-view"` (A9).
- 참조되는 뷰는 `placements`에 `"rail"`을 포함해야 한다(§3.3).
- **A1 강제(기계검사):** 파서는 `content` placement 뷰와 fileViewer에 `sidebar.left`가 없으면 검증 실패로 처리한다. 예외는 명시 플래그 `"decoration": true`(기본 false)를 선언한 뷰뿐이다. `transparent`·`nativeSurface`는 예외 사유가 아니다 — 브라우저 콘텐츠 뷰는 A1 대상이다. 강제 활성화 시점은 §7 4단계.

파일 패널의 결부: 결부 뷰가 `kind:"file"` 뷰면, 그 파일을 맡은 fileViewer의 sidebar 선언이 투영 근거다. fileViewer가 선언이 없으면 강등(A9)이다 — 코어가 특정 플러그인을 기본값으로 지명하지 않는다(A5).

### 3.2 consumes 규율

계약 주소 참조는 해당 계약 id의 consumes 선언을 요구한다 — 기존 계약-핀 규율 그대로다. 선언 없는 참조는 해소 단계에서 거부되고 슬롯은 강등된다.

### 3.3 placement 의미 재해석 — breaking

기존 `ViewPlacement`의 `sidebar-left` / `sidebar-right` / `sidebar-footer`는 "상주 도킹"에서 다음으로 재해석된다:

- `rail`: 레일에 투영·핀 가능한 사이드바 뷰. (기존 sidebar-left/right 통합 — 좌/우 방향은 배치 시점의 결정이므로 선언에 두지 않는다, A6)
- `rail-footer`: 레일 하단 상주 슬롯 (기존 sidebar-footer 승계).

breaking 변경이므로 plugin-spec 버전을 정직하게 bump하고, 기존 이름은 한 버전 동안 앨리어스로 수용 후 제거한다. 코어의 우측 레일 예약 manager(⚙) 패널은 A5 위반이므로 코어 소유의 레일 하드코딩을 제거한다(관리 표면은 별도 진입점으로 이동 — 구현 시 확정).

## 4. 상태·명령·이벤트

### 4.1 projection 상태

**레일 스코프 = 창 × 프로젝트, 결부 스코프 = 스페이스.** 프로젝트 레일 안에서 활성 스페이스의 단일 `railBindingViewId`를 해소한다. 패널 포커스는 결부 입력이 아니다.

```jsonc
// per (window, project)
{
  "binding": { "viewId": "v12 | null", "groupId": "g3 | null", "contentId": "c1 | null" },
  "focusHistory": ["viewId", "..."],            // 같은 프로젝트 내, 최근순, 승계용(세션 로컬)
  "left": {
    "slots": [
      { "source": "contract:… | self:…", "resolvedRef": "pluginId.viewId | null",
        "instanceKey": "…", "status": "live | degraded | satisfied-by-pin" }
    ],
    "template": "single | stack | tabs"
  },
  "right": null,                                 // 결부 뷰가 우를 선언 안 하면 null
  "pins": { "left": ["ref…"], "right": ["ref…"] }
}
```

### 4.2 명령 표면 (command registry 등재 — CLI/MCP 자동 노출)

| 명령 | 기능 |
|---|---|
| `ui.projection.state` | 활성 프로젝트의 projection 상태 읽기 (window 파라미터로 창 지정) |
| `ui.projection.pin` / `ui.projection.unpin` | 핀 추가/해제. 인자 = ref. shared·상주형만 핀 가능 — per-view 참조는 INVALID_PARAMS |
| `ui.intent.open` | 결부 문맥으로 열기 intent 발행 (레일이 내부적으로 쓰는 것과 동일 경로) |

이름은 명령 표면 규율(NAMING)에 따르되, 변경 시 본 문서를 갱신한다.

### 4.3 이벤트 (구독 기반 — 폴링 금지)

- `projection.changed`: 스페이스 결부·슬롯·핀 변경 시. 패널/그룹/활성 탭 포커스만 바뀐 경우에는 발화하지 않는다. 레일 렌더는 이 이벤트(상태 구독)로만 반응한다.
- `selection.changed`: 뷰의 selection 변경 시 (§4.4).

### 4.4 selection 계약

- 콘텐츠 뷰는 자기 selection `{type, ref, meta?}`을 코어에 보고한다 (기존 view status 축과 같은 보고 채널 패턴 — 뷰 레코드에 실려 뷰와 수명을 같이한다).
- 레일 뷰의 mount 컨텍스트는 "결부 뷰의 selection 구독"과 "결부 뷰로의 selection 발행"을 제공한다. 레일 뷰가 임의 뷰의 selection에 접근하는 API는 제공하지 않는다(A6 영향 범위 한정의 시행점).

### 4.5 지속성·복원

복원은 이 시스템의 1급 규범이다(R9). 저장 소유권:

- shared 인스턴스의 구조 상태(펼침·스크롤·필터): 투영 뷰가 (projectId, ref) 키로 소유·저장.
- **per-view 인스턴스의 구조 상태: 결부 뷰의 레코드(`View.state` 채널, 기존 B3)에 실어 뷰와 수명을 같이한다.** 원시 viewId를 별도 kv의 영속 키로 쓰는 것 금지 — viewId는 세션을 넘어 유일하지 않다(코어 기존 규칙). 뷰 닫힘 = 상태 소멸이 정의된 수명이다.
- selection: 뷰 레코드와 함께 저장.
- 핀·레일 구성: 프로젝트와 함께 저장, 콜드/웜 복원 시 레일 재현.
- `focusHistory`: 세션 로컬 승계 재료. 정본 결부인 `ContentArea.railBindingViewId`는 스냅샷에 영속된다.

**안정 정체성.** 복원이 콘텐츠 뷰 레코드를 보존하는 한 per-view 상태는 레코드에 실려 함께 복원된다. 복원 후 상태가 다른 뷰에 붙거나 유실되는 것은 결함이다.

## 5. 동작 규칙

**R1 투영 안정성.** 패널·그룹·활성 탭 포커스 변경은 레일 위치만 바꾸며 슬롯을 전환하지 않는다. 스페이스 전환·결부 뷰 소멸처럼 `railBindingViewId`가 실제로 달라질 때만 새 선언을 해소한다. 같은 instanceKey는 상태·스크롤을 보존하고 투영 뷰는 keep-alive한다.

**R2 intent와 배치.** 레일의 열기 동작은 intent 발행이다. 중앙은 (1) 배선 레지스트리(fileViewers·programs)로 핸들러를 해소하고 (2) 결부 문맥(그룹)에 배치한다. 배치 기본값: 기존 콘텐츠 패널을 대체하지 않고 탭 추가, 같은 리소스는 기존 뷰 재사용(멱등). 결부가 null이면(빈 프로젝트) 활성 스페이스의 활성 그룹에 배치하고, 그룹이 없으면 생성한다. 해소 실패는 결함이 아니다(A7) — 코어 강등 기본 동작으로 떨어진다.

**R3 클릭 문법.** 단일 클릭 = 선택(결부 뷰의 selection에 발행, 우 인스펙터가 있으면 반영). 더블클릭/Enter = 열기 intent. 드래그·컨텍스트 메뉴는 도구별 어포던스(예: 파일→터미널 드래그 = 경로 붙여넣기)로, 주 클릭 의미를 오염시키지 않는다.

**R4 핀.** 핀 스택은 투영 슬롯과 병존한다(레일 템플릿이 배열). 핀은 사용자 소유 상태로 결부 변화에 흔들리지 않는다.
- 핀 항목 = ref다(instanceKey가 아니다). **핀 가능한 것은 상주형(`resident: true` 선언 rail 뷰)뿐이다** — 그 외 rail 뷰는 선언-투영 전용(사이드바는 콘텐츠 기능에 종속, ②). per-view 참조는 핀 불가(명령·UI 모두 거부). 앨리어스 기간의 레거시 sidebar-* placement 뷰는 resident 로 간주한다.
- 핀과 투영이 같은 shared ref로 겹치면 **핀이 흡수한다**: 단일 렌더, 투영 슬롯은 `satisfied-by-pin`으로 표시된다.
- 상주형 뷰는 핀으로 레일에 산다 — A1의 대상이 아니고, 같은 플러그인이 중앙에 배선되어 열리는 순간 A1이 적용된다(예: mailbox 중앙 열림 → 좌=메시지 목록).

**R5 강등.** 참조 해소 실패(계약 미구현·비활성·consumes 위반) 시 해당 슬롯은 degraded 상태로 빈 슬롯+안내를 렌더한다(조치 가능한 정보). 선언 부재의 강등은 **A1 파서 강제 활성화(§7 4단계) 전까지 조용한 접기**다 — 이행기의 미선언 배너는 안내가 아니라 소음이다. 강제 활성화 후에는 선언 부재가 파서에서 거부되므로 런타임 미선언 자체가 사라진다. 다른 슬롯과 핀은 영향받지 않는다. 원인 해소(플러그인 적재 등) 시 상태 유실 없이 승격된다.

**R6 승계.** 결부 뷰가 닫히면 `railBindingViewId`를 비우고 **같은 스페이스 안의** focusHistory 최근 생존 뷰를 단 한 번 새 결부로 채택한다. 스페이스에 뷰가 없으면 결부는 null이고 투영 슬롯은 비우고 핀만 남는다.

**R7 스코프.** projection 상태·레일 인스턴스·shared 인스턴스의 범위는 (창, 프로젝트)다. 프로젝트 전환은 그 프로젝트의 레일 상태로 통째 전환한다(keep-alive). 창 사이에 결부·투영·인스턴스를 공유하지 않는다. shared 인스턴스의 mount 컨텍스트는 프로젝트 정체성(projectId·root)을 받는다 — 파일트리의 루트가 여기서 나온다.

**R8 레일 불가침.** 콘텐츠 분할 드래그로 레일 영역을 침범하거나, 레일을 콘텐츠 분할의 대상으로 삼을 수 없다(A3).

**R9 복원 완전성.** 콜드 재기동 후 projection은 종료 시점과 동형으로 재현된다: 스페이스별 `railBindingViewId`, 레일 슬롯 구성, 각 슬롯의 instanceKey 연결, 핀, 투영 뷰의 구조 상태, 뷰별 selection 전부. 웜 복원은 여기에 연속성(전환·깜빡임 없음)을 더한다. 복원 시점에 참조 플러그인이 아직 미적재면 슬롯은 강등(R5)으로 시작하고 적재 완료 시 상태 유실 없이 승격된다. 검증 기준은 기존 규율을 따른다: 콜드 1회만의 GREEN은 인정하지 않는다 — 연속 웜 GREEN까지 멱등이어야 한다.

### 5.1 레일 위치 모드 — FLOW / PIN (2026-07-21 사용자 확정)

좌 레일의 **가로 위치**를 정하는 프레임 속성이다(A5 — 코어 소유). 참조 핀(R4: 레일 안에 무엇이 사는가)과는 직교하고 이름만 겹친다 — R4의 핀은 ref 고정, 여기의 PIN은 **레일 자체의 위치** 고정이다. 두 축을 한 이름으로 부르지 않는다.

**기본 = FLOW(포커스 추종). PIN은 사용자가 명시적으로 켜는 상태다.**

**FLOW 규칙:**

- **F1 포커스 추종.** 활성 패널이 바뀌면 좌 레일이 그 패널 **바로 앞(왼쪽)**으로 이동한다. 이동은 스페이스의 결부·투영 콘텐츠를 바꾸지 않는다.
- **F2 형태 불변.** 레일은 항상 PIN 상태와 동일한 형태 — 화면 위아래를 가득 채우는 **전체 높이**, **원래(설정된) 가로 폭** — 를 유지한다. 패널 크기에 맞춰 줄어들지 않는다.
- **F3 수평 이동만.** 세로로는 움직이지 않는다 — 세로 그리드 라인을 따라 수평으로만 이동한다.
- **F4 공간 점유.** 오버레이가 아니다 — 패널 위에 뜨지 않고 실제 레이아웃 공간을 차지하며, 끼어든 만큼 다른 패널들이 재배치된다.
- **F5 그리드 보존.** 레일은 다른 패널을 세로로 가로지르지 않는 **"깨끗한" 세로 그리드 라인**에만 설 수 있다.
- **F6 스냅.** 포커스 패널의 왼쪽 라인이 깨끗하지 않으면(다른 패널에 걸리면), 그 패널 **앞쪽(왼쪽) 방향으로 그리드가 맞는 가장 가까운 깨끗한 라인**으로 이동한다.

**PIN 규칙:**

- **P1 현위치 고정.** PIN을 켜면 레일이 현재 라인에 그대로 고정된다 — 이후 포커스(결부) 변화에 이동하지 않는다.
- **P2 그립 드래그.** ⠿ 그립 드래그로 원하는 **유효한(깨끗한) 라인**에 직접 옮겨 고정할 수 있다. 유효하지 않은 위치에는 놓을 수 없다(F5와 같은 기준).
- **P3 해제 = FLOW 복귀.** PIN을 끄면 즉시 F1~F6이 재적용된다.

미정(이번 확정 범위 밖 — 구현 시 확정): 우 레일 적용 여부, 위치 모드·PIN 위치의 영속 스키마(§4.5 편입), 명령 표면 이름(NAMING 등재).

## 6. 도구별 배정표 (초기 정본)

■확정 = 사용자 지정 / 흡수 = 기존 내부 레일 이관 / 기존 = 이미 분리된 뷰 재배정 / 신규 = 정의 필요.
교차 플러그인 참조는 전부 계약 주소다(§3.1) — 표의 이름은 대상 설명이지 ref 문법이 아니다.

| 콘텐츠 도구 | 좌 (필수) | 우 (선택) |
|---|---|---|
| 터미널 (xterm/ghostty) | ■ 파일트리 shared (+ 커맨드 블록 per-view 스택 후보) | 세션/블록 상세 (신규 후보) |
| 에디터 (codemirror, fileViewer) | ■ 파일트리 shared | 아웃라인/심볼·진단 (신규 후보) |
| 브라우저 (chromium/native) | ■ 즐겨찾기 (기존 bookmarks) | DOM 선택 검사 (기존 dom-picker) |
| media-viewer (fileViewer) | 파일트리 shared | 미디어 메타 (신규) |
| db-studio | 테이블 내비+커넥션 per-view (흡수) | 속성 편집기 per-view (흡수) |
| design-astryx | 구조 트리 per-view (흡수) | 인스펙터 per-view (흡수) |
| design-studio | 라이브러리 (흡수) | 속성 편집 per-view (흡수) |
| kanban | 이슈 트리/아웃라인 per-view (신규) | 이슈 상세 (모달 → 이관) |
| playbox player | 미디어 라이브러리 (기존 우측 뷰 → 좌 재배정) | 클립/재생 속성 (신규) |
| git-diff / git-review | 변경 파일 목록 (상단 목록 → 이관) | 리뷰 코멘트 (하단 → 이관) |
| git-history | 커밋 목록 (뷰 본체 → 좌, 중앙=패치 상세) | 커밋 메타/파일 목록 |
| workflow | 원장 run 목록 | run 상세/drift |
| runbook | 그룹·명령 목록 | 명령 편집 폼 (인라인 → 이관) |
| clubhouse | 참여자 로스터 (상단 탭 → 이관) | 에이전트 상태/상세 |
| agent-claude(-gui)/codex | 세션 목록·계보 (신규) | 세션 상세/큐 |

상주형(핀 후보, A1 비대상): mailbox, clipboard, activity, memo, folderpop, agents-hooks, sidebar-sky(rail-footer).
헤드리스(뷰 없음, 합법): git-core, git-init, doctor, agents-acp, icons-*, editor-format-json, editor-codemirror-todo, tmux-fake, remote-iroh, reminder-demo.

## 7. 이행 계획

1. **코어**: projection 상태·명령·이벤트(§4) + 레일 투영 렌더(R1) + intent 채널(R2). manager(⚙) 레일 하드코딩 제거. placement 재해석(§3.3) — plugin-spec bump. 사이드바 계약(§3.1) 파싱.
2. **파일럿**: 터미널·에디터 → 파일트리 shared 계약 참조. 이 한 쌍이 A2·A4·A8·A9·A10을 전부 관통 검증한다.
3. **흡수 3종**: db-studio, design-astryx, design-studio — 내부 레일을 rail 뷰로 방출하고 선언 전환.
4. **전 플러그인 선언**: 배정표(§6)대로 sidebar 선언 추가. 파서의 A1 강제는 이 단계 완료 후 활성화(그 전까지 선언 부재 = R5 강등으로 관용).
5. **docs 이행**: 구현 완료분을 docs/SIDEBAR.md에 현재시제로 반영(영문+한글).

### 7.1 기존 표면 마이그레이션

새 모델이 무효화하는 기존 표면을 명시한다. 각 항목은 구현 시 NAMING 대조표에 등재한다.

| 기존 표면 | 처분 |
|---|---|
| `sidebar.left.tree` / `sidebar.left.move` / `sidebar.left.resize` | 핀 스택 배열 조작으로 재정의(핀 순서·분할 비율). 투영 슬롯은 대상 아님 |
| `sidebar.right.mode` (overlay/push) | 유지 — 레일 프레임 속성이므로 모델과 직교 |
| `project.sidebar.toggle` / `project.rightbar.toggle` | 유지 — 레일 열림/닫힘은 프레임 속성. 설명문만 갱신("파일트리 사이드바" → "좌 레일") |
| `plugin.view.open`의 sidebar-left/right 라우팅 | placement 재해석(§3.3)에 맞춰 rail 핀 추가로 재정의 |
| 스냅샷의 `leftLayout` / `rightView` | 콜드 복원 1회 이관: 기존 배치 뷰들 → 좌/우 핀 목록으로 변환. 이후 스냅샷은 §4.5 스키마 |

각 단계는 RED→GREEN을 따른다. 검증 노출면은 이 스펙이 이미 정의한다: `ui.projection.state`(결부·슬롯 단언), `projection.changed`(전환 단언), `window.snapshot`(레일 시각 검증), `ui.intent.open`(배치 정책 단언).

복원 검증(R9)은 별도 시나리오로 각 단계에 포함한다: 결부·핀·구조 상태를 구성 → 재기동 → `ui.projection.state` 동형 단언 + `window.snapshot` 시각 대조 → 연속 웜 재기동으로 멱등 확인.

## 8. 비목표

- 상단 툴바·하단 패널·상태바의 정형화 (A10 판별 기준 — 인스턴스 산출물은 내부 잔류).
- 오버레이(overlay-draw·sakura 등)와 상주형 뷰에 대한 A1 적용.
- 레일의 좌우 위치 사용자 커스텀(좌우 스왑) — 차후 논의.
- 창 간 결부 공유.

## 9. 적대검증 기록 (2026-07-21)

6렌즈(논리·코드·법·시나리오·계약·UX) 53에이전트, 발견 47건 중 14건 확정·33건 기각. 확정분 반영 내역:

1. 결부 축 — 결부 대상=콘텐츠 뷰, 결부 스코프=스페이스, 레일 스코프=창×프로젝트, 정본=`ContentArea.railBindingViewId`.
2. ref 계약 주소화 — `<pluginId>.<viewId>` 이름-핀 금지(C3 L1), `{contract, range}` + implements/consumes (critical).
3. fileViewers 선언 축 — 에디터·media-viewer는 views가 없는 fileViewer라 선언 자리가 없었음 (major).
4. A1 예외의 기계검사화 — `decoration: true` 명시 플래그만, transparent/nativeSurface는 예외 아님 (major×2).
5. per-view 영속 = View.state 채널 — 원시 viewId kv 영속 금지(코어 기존 규칙과 정합) (critical).
6. 핀 의미론 — ref 전용, shared·상주형만, 핀-투영 중복은 핀이 흡수 (minor+major).
7. 결부 null intent 정의 (minor).
8. 기존 사이드바 명령·스냅샷 마이그레이션 절 신설 (major).
