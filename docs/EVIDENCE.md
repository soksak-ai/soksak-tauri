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

## 브라우저 게이트 보고서

한 실행의 정본 보고서는 `browser-gates.json` 하나이며 항상 3 엔진 × 12 게이트를 전부 담는다.
신원(framework·platform·buildId·runId)은 실행 중에 바뀌지 않고, 다른 신원으로 기록하려는 시도는
저장하지 않고 거절한다 — 한 파일이 두 프레임워크의 사실을 함께 들 수 없다.

`green`은 같은 증거를 다시 판정해 상태·사유·근거가 모두 일치하는 judge 영수증이 있어야만 저장한다.
측정을 이어갈 수 없게 된 칸은 사유와 함께 `blocked`로 저장하며, 재지 못한 칸을 `red`로 저장하지
않는다. 보고서는 판정을 기록할 때마다 다시 쓰이므로 실행이 중간에 끊겨도 그때까지의 측정이 정본에
남는다.

인수 합계는 프레임워크마다 하나씩 나온 이 보고서들을 모아서 낸다. 파일 하나로는 인수를 닫지 못한다.

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

## 브라우저 시각 검토

브라우저 canonical report의 `visualReview`는 기본적으로 `pending`이다. 녹화·snapshot 생성이나
machine gate 통과는 이 상태를 자동으로 바꾸지 않는다. 사람이 artifact를 직접 확인한 뒤
`createBrowserGateReportStore(...).recordVisualReview(...)`에 framework, engine, gate,
`passed|failed`, 검토한 artifact 상대경로와 메모를 명시해야만 판정이 기록된다. 이 경로는
`setVisualReviewStatus`의 닫힌 schema를 사용하며 machine evidence와 독립적이다.
