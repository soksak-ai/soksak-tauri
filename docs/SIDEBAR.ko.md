# soksak 사이드바 — 투영 레일 (v2)

`docs/ARCHITECTURE.md`(뼈대 계약)의 자식 문서다. 전역 레일 두 개(좌·우)와 레일 푸터를 규율한다. 충돌 시 부모 계약이 이긴다. 이 문서와 코드가 다르면 코드를 고친다. 이 문서와 단일진실 스키마가 다르면, 스키마가 강제할 수 있는 것은 스키마가, 나머지는 이 문서가 이긴다.

이 모델의 결정 기록 — 공리 A1~A10, 규칙 R1~R9, 도구별 배정표 — 은 `plans/sidebar-projection-spec.md`다. 이 문서는 현재 출하된 동작만 현재시제로 서술하고 유도 과정을 재진술하지 않는다.

---

## 1. 모델

모든 창은 `[좌 레일 | 콘텐츠 | 우 레일]`로 배치된다. 분할은 콘텐츠에서만 재귀·무제한이고, 레일은 콘텐츠 분할을 품지 않는다.

레일은 세 밴드로 구성된다:

- **투영 슬롯** — 스페이스의 단일 결부 뷰(`railBindingViewId`)가 선언한 사이드바가 해소·렌더되는 곳. 뷰 활성화는 **해소 결과가 달라질 때만** 스페이스를 재결부한다 — 같은 기능 간 이동(터미널↔터미널)은 결부를 유지하고 FLOW 위치만 옮기며, 다른 기능(또는 다른 per-view 문서)으로의 전환은 투영을 교체한다. 레일 상호작용은 둘 다 바꾸지 않는다.
- **핀 스택** — 예약 상태. 좌 레일에는 사용자 핀 축이 없다: 투영만 렌더한다. 플러그인 소유 상주 표면은 우측 레일의 몫이며 그 렌더러가 생길 때 열린다. 구 스냅샷의 잔존 핀은 관용 렌더되고 `ui.projection.unpin`으로 제거할 수 있다.
- **레일 푸터** — 하단에 상주하는 `rail-footer` 뷰.

도구는 사이드바를 자기 뷰 안에 그리지 않는다. 콘텐츠 뷰는 사이드바를 *선언*하고, 레일이 그것을 투영한다. 선언에서 좌는 필수, 우는 선택이다. 선언 없는 콘텐츠 뷰는 파스 에러다(A1) — 면제는 `decoration: true` 하나뿐이다.

## 2. 선언

`contributes.views[]`의 `content` placement 항목과 `contributes.fileViewers[]` 항목은 `sidebar` 필드를 가질 수 있다:

```jsonc
"sidebar": {
  "left":  [ { "contract": "soksak-spec-plugin-sidebar-file-tree", "range": "^0.0.1", "view": "tree", "instance": "shared" } ],
  "right": [ { "ref": "self.inspector", "instance": "per-view" } ],
  "template": "stack"        // 한 쪽 슬롯이 2개 이상일 때: "stack" | "tabs"
}
```

- 슬롯 참조는 자기 rail 뷰(`ref: "self.<viewId>"`) 또는 활성 구현체로 해소되는 **계약 주소**(`{contract, range, view}`) 둘뿐이다 — 플러그인 id 이름-핀은 거부된다(부모 C3). 교차 플러그인 계약 참조는 대응하는 `consumes` 핀을 요구한다.
- `instance`는 정체성 축이다: `shared` = 프로젝트당 하나(`projectId|ref`), `per-view` = 결부 콘텐츠 뷰당 하나(`projectId|ref|viewId`).
- 참조되는 뷰는 `rail` placement를 가진다. `rail-footer`는 하단 상주 슬롯이다. `resident: true`는 우측 상주 표면 대상 표식이며, 좌 레일 존재를 부여하지 않는다.
- `decoration: true`는 사이드바 의무 면제의 명시 표식이다. `transparent`/`nativeSurface`는 면제 사유가 아니다.

해소 실패 — 계약 미구현·제공자 비활성·consumes 부재 — 는 그 슬롯만 빈 슬롯+안내로 강등하며, 다른 슬롯과 핀에 영향이 없고, 원인 해소 시 상태 유실 없이 승격된다.

## 3. 투영 동작

- **안정성**: 한 스페이스에는 결부 하나만 있고, 활성 뷰의 해소가 달라질 때만 재결부된다. 같은 해소의 포커스 이동은 FLOW 위치만 옮기고 슬롯·인스턴스·스크롤·상태는 유지된다.
- **keep-alive**: 투영 인스턴스는 마운트 유지·display 토글. 죽은 per-view 인스턴스(결부 뷰 닫힘)와 흡수된 인스턴스는 퇴거된다.
- **흡수**: 구 스냅샷에서 잔존한 핀된 shared 참조는 자기 투영 슬롯을 흡수한다(`satisfied-by-pin`) — 핀이 제거될 때까지 핀 스택이 단일 렌더를 소유한다.
- **열기 intent**: 레일 뷰의 열기는 결부 문맥(결부 그룹)으로 흐른다 — 기존 패널을 대체하지 않고 탭 추가, 같은 리소스는 기존 뷰 재사용. 결부가 없으면 활성 그룹에 배치한다. 그 밖의 교차 도구 동작은 여느 소비자처럼 계약-핀 하의 command로만 흐른다.
- **승계**: 결부 뷰가 닫히면 같은 스페이스의 focus-history 최근 생존 뷰로, 그다음 인접 탭으로 승계한다.
- **복원**: 콜드 재기동은 투영을 동형으로 재현한다 — 스페이스별 결부·슬롯 구성·instanceKey 연결·구조 상태. 잔존 핀은 제거될 때까지 프로젝트별 창 스냅샷에 영속된다.

## 4. 명령과 이벤트

| 표면 | 동작 |
|---|---|
| `ui.projection.state` | 프로젝트의 결부(뷰/그룹/스페이스), 해소된 슬롯과 상태(`live`/`degraded`/`satisfied-by-pin`), 핀, focus history 를 읽는다. |
| `ui.projection.pin` / `unpin` | `pin`은 양쪽 다 거부한다: 좌 레일은 투영 전용(핀 축 없음), 우측은 예약된 플러그인 표면으로 그 핀 스택 렌더러가 생기기 전까지 거부. `unpin`은 잔존 핀을 멱등 제거한다. |
| `ui.intent.open` | 결부 문맥으로 경로를 연다(레일이 쓰는 것과 같은 경로). |
| `projection.changed` | 해소 지문 — 스페이스 재결부·슬롯 상태·핀 — 이 바뀔 때 발화한다. 같은 해소의 포커스 이동은 발화하지 않는다. 부트 관측은 무발화다. |

`plugin.view.open`은 `rail`·`rail-footer` placement를 열기 대상이 아니라 거부한다 — rail 뷰는 사이드바 선언으로만 나타난다. dev 소스 적재는 dev identity 전용이며, debug·release 홈은 발행본 설치로 검증한다.

## 5. 원칙 (S1–S10)

HARD 규칙이다. 의도적으로 절대형으로 서술한다.

### S1. 호스트는 프레임만 렌더한다.
투영 밴드·핀 스트립·본문 슬롯·푸터 슬롯·폭·표시 여부는 호스트의 것. 본문 슬롯 안의 모든 것은 플러그인의 것. 한 뷰에 속한 컨트롤은 그 뷰에 산다.

### S2. 레일 어디에도 하드코딩 콘텐츠는 없다.
내장 FILES 탭도, 레일 본문의 코어 예약 패널도 없다. 렌더되는 모든 본문은 선언 또는 핀을 거쳐 등록된 `PluginViewProvider`에서 온다. 코어 관리 표면은 레일 밖에 산다(플러그인 매니저는 모달).

### S3. 빈 레일은 프레임 그 자체다.
핀 0개에 투영 밴드가 접힌 레일은 프레임만 렌더한다. 빈 상태는 정당하고 안정적인 상태다.

### S4. 뷰 컨텍스트가 레일 뷰로 들어가는 유일한 채널이다.
레일 마운트는 `{ projectId, root, paneId, boundViewId, setBadge }`와 `app.*` capability만 받는다 — `boundViewId`는 투영 인스턴스가 섬기는 콘텐츠 뷰를 지명한다(per-view 스토어 연결). 콘텐츠 전용 필드(`setStatus`·`setTitle`·`setIcon`·`setRestoreState`)는 레일에서 no-op이다. 스토어도 레이아웃 트리도 테마 객체도 이 경계를 넘지 않는다.

### S5. 선택·keep-alive·폴백은 호스트의 것이다.
호스트가 핀 탭 선택을 소유하고 비활성 뷰를 살려 둔다. 뷰가 등록 해제되면 매달린 선택이나 고아 마운트 없이 폴백한다. 재적재된 뷰는 현재 상태에서 재조정한다.

### S6. 테마는 호스트 CSS 변수로만.
레일 뷰는 호스트가 전파한 CSS 커스텀 프로퍼티로만 테마를 상속한다.

### S7. cwd 추종은 opt-in capability다.
추종자는 컨텍스트 `paneId`를 읽고 `app.terminal`로 구독한다. 호스트는 아무것도 밀어넣지 않는다.

### S8. 추종 토글은 뷰의 것이다.
파일 탐색기의 cwd 추종은 탐색기의 헤더 토글이며 기본은 프로젝트 루트다. 호스트에 추종 모드는 없다.

### S9. 뷰는 선언된 경계로만 나타난다.
등록(`contributes.views[]` + `registerView`), 사이드바 선언(콘텐츠 뷰·파일뷰어의 `sidebar`), 핀. 레일로 들어오는 다른 길은 없다.

### S10. 검증하라, 가정하지 마라.
레일 정합은 증명된다: `ui.projection.state`로 결부·슬롯 단언, `projection.changed`로 전환 단언, `window.snapshot`을 직접 읽어 픽셀 확인, 복원은 콜드 **그리고** 웜 멱등까지 — 콜드 1회는 인정하지 않는다.

---

## 6. 정합 검사

- **프레임 전용/무하드코딩**: 호스트에서 뷰 이름·내장 탭 grep = 0. 레일은 등록된 provider만 렌더한다.
- **투영**: 선언 뷰 결부 → `ui.projection.state`의 슬롯이 선언된 instanceKey로 `live`; 같은 shared 계약의 다른 소비자로 전환 → instanceKey 불변·remount 없음.
- **좌 레일 투영 전용**: `ui.projection.pin`은 양쪽 다 거부; 잔존 흡수 핀을 해제하면 그 슬롯이 `satisfied-by-pin`→`live`로 복귀.
- **강등**: 제공자 비활성 → 그 슬롯만 강등; 재활성 → 상태 유지 승격.
- **복원**: 결부+핀+구조 구성 → 재기동 → `ui.projection.state` 동형 + 스냅샷 시각 일치 → 웜 반복.

---

버전: 0.0.3
상태: AUTHORITATIVE (영문판 `docs/SIDEBAR.md`와 동시 갱신)
부모: `docs/ARCHITECTURE.md` (상속, 재진술 없음) · 결정 기록: `plans/sidebar-projection-spec.md`
단일진실: `@soksak-ai/plugin-spec`(`packages/plugin-spec/src/spec.ts`), `src/state/projection.ts`, `src/state/projectionWiring.ts`, `src/plugins/viewRegistry.ts`, `src/commands/catalogProjection.ts`
이 문서는 스키마가 강제하지 못하는 조언만 더한다.
