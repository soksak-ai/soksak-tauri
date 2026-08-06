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
