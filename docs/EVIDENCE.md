# E2E Evidence Store

E2E 실행 증거는 선언된 절대 root 아래 세 역할로 저장한다.

- `current/`: 한 실행만 쓰는 작업 디렉터리다. `run.json`의 상태가 `running`일 때만 artifact를 쓴다.
- `runs/<sha256(runId)>/`: 완료된 실행의 정본이다. 경로는 정확한 UTF-8 `runId`의 SHA-256으로 결정하며 디렉터리의 `run.json`이 원래 runId와 상태를 보존한다.
- `last-red/`: 최신 RED 정본의 읽기용 복사다. 진단 편의를 위한 별칭이며 과거 run의 소유자가 아니다.

`machine-green`과 `red`는 모두 완료 전에 `runs`에 보존한다. 다음 실행이나 다음 RED는 기존
`runs` 항목을 수정하거나 삭제하지 않는다. RED는 정본을 만든 뒤 `current`를 비우고 그 정본에서
`last-red`를 다시 만든다. 따라서 `last-red` 갱신 실패가 이미 닫힌 run의 증거를 잃게 해서는 안 된다.

저장소는 runId 문자열을 파일명 안전성의 근거로 사용하지 않는다. 임시 디렉터리 이름, 앱 home,
프레임워크 이름 같은 휴리스틱으로 저장·삭제 경계를 넓히지 않는다. 모든 변경 대상은 선언된 root와
해시로 도출한 정확한 경로여야 하며 symlink와 특수 파일은 거부한다.

실행당 hard cap은 1 GiB, 저장소 전체 hard cap은 2 GiB다. `keep`은 한도를 해제하지 않는다.
자동 quota 확보를 위해 과거 정본을 지우지 않으며, 공간이 부족하면 새 증거 쓰기나 완료를 명시적으로
실패시킨다.

`scripts/e2e/lib/evidence-store.test.mjs`가 연속 RED, GREEN 보존, 최신 RED 별칭, 경계,
quota와 동시 거래를 검증한다.

## 증거 배선 장부

증거 봉투를 만드는 mapper 는 checkpoint 필드를 손으로 나열하지 않는다. 손으로 나열한 목록은
생산자 이름이 바뀌어도 조용히 어긋난다 — 소비 필드가 없으면 `=null` 로만 새고, 생산 필드를
아무도 읽지 않으면 아무 신호도 내지 않는다.

`scripts/e2e/lib/browser-machine-judge-support.mjs`의 `mapWithWiring(source, label, build)`이
그 대조를 소유한다. mapper 는 `checkpoint.take(key)`로만 읽고, 봉인 시점에 checkpoint 자신의
키 집합과 읽은 키 집합을 맞대 예약 키 `evidenceWiring`에 장부를 싣는다.

```
evidenceWiring = { source, unconsumed, unproduced, error }
```

`requireExactKeys`와 `requireEvidenceEnvelope`가 이 예약 키를 각 게이트의 닫힌 스키마 대조에서
건너뛰고, 대신 장부를 실패 이름으로 펼친다. 어느 게이트도 자기 키 목록에 `evidenceWiring`을
적지 않는다.

- `wiring.<source>.<name>=produced-not-consumed` — 생산자가 넣었고 아무도 읽지 않았다.
- `wiring.<source>.<name>=consumed-not-produced` — 소비자가 읽었고 아무도 넣지 않았다.
- `wiring.<source>=mapper-threw/"<error>"` — mapper 가 던졌다. 하니스는 죽지 않고 판정이 RED 다.

장부가 없는 봉투는 배선을 재지 않은 것이며 아무 실패도 만들지 않는다. 비어 있는 장부와 없는
장부는 서로 다른 사실이다.

`scripts/e2e/lib/browser-machine-judge-support.test.mjs`가 두 방향, throw, 손상된 장부,
JSON 왕복을 검증한다. B03 적용은 `scripts/e2e/lib/browser-gate-b03-evidence.test.mjs`가 소유한다.

## 36칸 보고서의 게이트 소유

정본 3x12 보고서는 실행기 하나가 다 채우지 못한다. B12 는 프로세스를 세 번 죽였다 살려야 재는
냉시작 게이트라 살아 있는 앱 한 번으로 도는 B01~B11 과 같은 실행에 들어갈 수 없다. 그래서
실행기가 둘이고, 어느 칸이 누구 것인지는 `scripts/e2e/lib/browser-gate-report-merge.mjs` 의
`BROWSER_GATE_OWNERS` 한 자리에만 산다. 하니스는 목록을 다시 적지 않고 `browserGatesOwnedBy`
로 읽는다.

`createBrowserGateReportStore({ gates })` 가 그 선언을 시행한다. 선언하지 않은 칸에는
`recordMachineEvidence` 도 `recordMachineStatus` 도 판정을 적지 못하고, 측정을 잃은 엔진을 닫는
`blockPending` 도 소유한 칸만 닫는다. 재지 못한 남의 칸을 차단으로 적으면 그 게이트의 소유자가
낸 판정이 들어갈 자리가 사라진다 — 재지 않은 칸은 `not-run` 으로 남는다.

`mergeBrowserGateReports(contributions)` 가 두 보고서를 한 판으로 잇는다. 기여는
`{ gates, report }` 이며 다음을 모두 만족해야 한다.

- 소유가 12칸의 분할이다. 빠진 칸도 겹친 칸도 이름으로 거절한다.
- `framework`, `platform`, `buildId` 가 같다. 다른 artifact 의 측정은 합치지 않는다.
- 기여가 소유하지 않은 칸은 `not-run` 이거나 `not-applicable` 이다. 소유 없이 적힌 판정은
  이름으로 거절한다.

병합본의 `runId` 는 기여한 실행 id 를 순서대로 `+` 로 이어 붙인 이름이다. 영수증은 병합 신원으로
다시 발급되지만 증거는 그대로이고 판정은 같은 판사가 같은 값에서 다시 낸다 — 재판정 결과가 원래
상태와 다르면 병합이 실패한다.

## B12 냉시작 판정의 기록 경로

`scripts/e2e/titlebar-composition.mjs` 는 cycle 하나를, `scripts/e2e/titlebar-composition-summary.mjs`
는 냉시작 3회 집계를 소유한다. 집계 판정(`judgeTitlebarColdStartRun`)을 `b12ColdStartCells` 가 B12
칸 입력으로 옮기고, 요약기가 `titlebarGateStoreRoot(home)` 의 증거 저장소에 정본 형식
`browser-gates.json` 으로 적는다.

칸이 `green` 이 되는 조건은 집계가 소유한다 — 냉시작 3회 × 모든 창 × 세 엔진이 전부 green 이어야
한다. 그때 칸이 드는 영수증은 마지막 냉시작의 마지막 창 표본이며, 표본 하나가 통과의 근거가 아니라
실행 전체 판정을 기계가 다시 확인할 수 있는 닻이다. 닻이 없는데 green 을 말하면 배선 오류이므로
던진다. 집계가 green 이어도 그 표본이 B12 판사를 통과하지 못하면 칸은 red 이고 요약기는 실패한다.

## 배율은 창의 사실이다

판정에 쓰는 배율은 `scripts/e2e/lib/surface-scale.mjs`의 `displayScaleFact(window.info)` 하나를
지난다. 캡처 산출물은 이 값을 정하지 못한다.

PNG 는 그 사실을 나중에 손실을 거쳐 다시 잰 사본이다. 사본이 정본을 정하면 판정의 허용오차가
캡처 파이프라인을 따라 흔들린다 — `windowedSurfaceCompositionVerdict`의 `physical()`이 이 값으로
반올림하므로, 사본이 1 로 내려앉는 순간 서로 다른 두 사각형이 같은 정수가 된다.

`displayScaleFact`는 `window.info` 레코드만 받고 맨 숫자를 거절한다. 캡처에서 잰 배율은 맨
숫자로 돌아다니므로, 사실을 요구하는 자리가 숫자를 거절하면 그 혼입이 표현 불가능해진다.
사실이 없으면 **측정 불가**이므로 던진다 — 1 로 대체하지 않는다. 못 읽음은 성공값으로 표현될 수
없다.

`snapshotScaleForVisualEvidence`는 창의 사실을 `scale`로, 캡처에서 다시 잰 사본을
`capturedScale`로 함께 싣는다. 둘이 어긋나면 사실을 바꾸는 대신 어긋났다는 사실에 이름을 준다.

녹화 완결성도 같은 축이다. 프레임 수가 모자란 것은 사람이 볼 캡처의 사실이지 machine gate의
통과 조건이 아니다. 그것으로 던지면 judge 가 닿지 못해 칸이 통째로 `blocked`가 되고, 계약 위반이
수치로 남을 자리를 잃는다.

던질 것과 실을 것을 가른다.

- **측정 불가**(주소 없음, 창 없음, 명령 무응답, 배율 사실 없음) — 던진다. `blocked`가 옳다.
- **계약 위반**(station 변경, rect 불일치, z 순서 틀림, 값이 기대와 다름, 녹화 프레임 부족) —
  던지지 말고 evidence 에 실어 judge 가 `red`로 판정하게 한다. 보고서에 이름이 남아야 한다.

`scripts/gates/visual-judgment-provenance.mjs`가 두 규칙을 소스에서 센다. 캡처에서 나온 이름이
기계 판정 입구에 인자로 들어갔는지, 녹화 완결성을 기대값과 맞대 던지는지 본다. 봉투 스키마를
거절하는 throw 와는 구분한다 — 그 throw 는 `reviewVisualRecordingSafely`가 받아 증거로 바꾼다.

## 브라우저 시각 검토

브라우저 canonical report의 `visualReview`는 기본적으로 `pending`이다. 녹화·snapshot 생성이나
machine gate 통과는 이 상태를 자동으로 바꾸지 않는다.

시각 검토는 machine 판정이 닫힌 **다음에**, 사람이 캡처를 열어 본 뒤에 선다. 그래서 검토는 살아
있는 실행 안이 아니라 저장된 정본 보고서 위에서 이뤄진다.

```
node scripts/e2e/visual-review.mjs --report <runs/...>/browser-gates.json --list

node scripts/e2e/visual-review.mjs \
  --report <runs/...>/browser-gates.json \
  --engine browser-chromium --gate B04 --status passed \
  --artifact browser-chromium/first-paint.png \
  --artifact browser-chromium/flow-right/f0048.png \
  --notes "좌우 전환에서 레일이 붙어 있고 표면이 밀리지 않는다"
```

`--list`는 아직 사람이 안 본 칸을 machine 상태와 함께 센다. 기록은 `--status`, `--artifact`,
`--notes`를 전부 사람이 적어야 서고, 적은 artifact 가 보고서 디렉터리 안에 실제로 있는지 확인한
뒤에만 정본에 쓰인다. 못 본 것을 봤다고 적을 수 없어야 하기 때문이다. 판정이 서기 전에는 정본을
건드리지 않으며 교체는 원자적이다. 같은 검토를 두 번 적으면 같은 정본이 나온다.

실행 중에 사람이 판정을 남기는 자리는
`createBrowserGateReportStore(...).recordVisualReview(...)`다. 두 자리가 서로 다른 기준을 들지
않도록 검사는 `browser-visual-review.mjs`의 `requireHumanVisualReview` 하나뿐이다. 둘 다
`setVisualReviewStatus`의 닫힌 schema 를 쓰며 machine evidence 와 독립적이다.

자동으로 `passed`가 되는 경로는 어느 쪽에도 없다. 그 경로가 생기면 "모든 UI gate 의
`visualReview`가 passed"라는 최종 조건은 아무것도 뜻하지 않게 된다.
