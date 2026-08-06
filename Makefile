# soksak 빌드/실행 명령 — 멱등하고 버전관리되는 단일 진입점.
# 임의 명령 대신 항상 이 타깃을 사용한다. (`make help` 로 목록 확인)
#
# 3-정체성 구분(독에서 한눈에):
#   soksak-dev         = HMR 개발 서버(make dev). 번들 아님 → 바이너리명이 독에 그대로.
#   soksak-tauri-dev   = 개발 정체성 앱 번들(make build-dev). 초록 아이콘.
#   soksak-tauri-debug = 디버그 앱 번들(make build-debug). 주황 아이콘.
#   soksak-tauri       = 릴리스 앱 번들(make build). 기본 아이콘.
# 기본 설정(tauri.conf.json)이 dev 정체성이고, 빌드 시 --config 로 정확히 푼다.

SHELL := /bin/bash
PNPM  := pnpm

# 레지스트리 카탈로그 단일 진실(P2) — 코어는 이 URL 만 안다. src/state/registry.ts 와 동일.
REGISTRY_URL := https://raw.githubusercontent.com/soksak-ai/soksak-plugin-registry/main/registry.json

# cargo 산출물 자리 — **cargo 에게 묻는다.**
#
# 손으로 적으면 워크스페이스 뿌리가 옮겨간 뒤에도 옛 자리가 남아 있는 한 조용히 그 옛 산출물이
# 잡힌다. 실측 2026-08-01: 뿌리는 이미 저장소 루트로 옮겨갔는데 열여덟 곳이 옛 자리를 그대로
# 가리켰고, 나는 7/28 바이너리로 검증해서 그날 고친 결함이 아직 살아 있다는 답을 받았다.
# 오류는 없었다. 답만 틀렸다.
# 옛 워크스페이스 뿌리가 남긴 고아 산출물. **이 이름은 여기 한 번만 적는다** — 지우는 명령
# 말고 아무도 이 자리를 알아서는 안 된다(알면 조용히 옛 산출물을 잡는다).
ORPHAN_TARGET := frameworks/tauri/target

CARGO_TARGET := $(shell cargo metadata --no-deps --format-version 1 --offline 2>/dev/null | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
# 앱과 sidecar가 반드시 같은 아키텍처여야 한다. Tauri CLI가 Node 실행물의 아키텍처를 앱의
# target으로 추측하게 두지 않는다(실측: x86 Node가 arm64 Cargo 앱의 sidecar를 x86으로 요구).
# 교차 빌드는 `make … TAURI_TARGET=<triple>`로 같은 한 값을 양쪽에 넘긴다.
TAURI_TARGET ?= $(shell rustc -vV | sed -n 's/^host: //p')
TAURI_TARGET_DIR := $(CARGO_TARGET)/$(TAURI_TARGET)

RELEASE_CONFIG := frameworks/tauri/tauri.build-release.conf.json
RELEASE_CONFIG_GENERATED := $(CARGO_TARGET)/release-config/tauri.conf.json
DEBUG_CONFIG   := frameworks/tauri/tauri.build-debug.conf.json
DEV_BUNDLE_CONFIG := frameworks/tauri/tauri.build-dev.conf.json

RELEASE_APP := $(TAURI_TARGET_DIR)/release/bundle/macos/soksak-tauri.app
DEV_APP     := $(TAURI_TARGET_DIR)/debug/bundle/macos/soksak-tauri-dev.app
DEBUG_APP   := $(TAURI_TARGET_DIR)/debug/bundle/macos/soksak-tauri-debug.app
DEV_EXECUTABLE := $(DEV_APP)/Contents/MacOS/soksak-dev
DEV_CLI := $(CARGO_TARGET)/debug/sok-dev
DEV_LOG_DIR ?= $(HOME)/.soksak-dev/logs
# 창 호스트 IPC와 영속 저장소 daemon은 서로 다른 공개 좌석이다.
DEV_HOST_SOCKET := $(HOME)/.soksak-dev/com.soksak.dev.sock
DEV_CORED_SOCKET := $(HOME)/.soksak-dev/cored.sock

.DEFAULT_GOAL := help

.PHONY: clean-orphan-target doctor doctor-fix help install icons dev build build-dev build-debug run run-dev rebuild-dev restart-dev run-debug typecheck check test test-front verify gates e2e-framework-binding e2e-slot-freeze-dev e2e-titlebar-dev clean stop cli cli-dev cli-debug install-cli install-cli-dev install-cli-debug docs docs-dev registry

help: ## 사용 가능한 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  make %-13s %s\n", $$1, $$2}'

install: ## 의존성 설치(멱등)
	$(PNPM) install

icons: ## 앱 아이콘 전체 재생성(SVG→마스터1024 + base/dev/debug 아이덴티티). 멱등
	@command -v magick >/dev/null || { echo "ImageMagick(magick) 필요"; exit 1; }
	bash scripts/logo/appicon.sh
	cp frameworks/tauri/icons/icon.png /tmp/soksak-icon-master.png   # 1024 스냅샷 — tauri icon 이 icon.png 를 512 로 덮으므로 보존
	$(PNPM) tauri icon /tmp/soksak-icon-master.png --output frameworks/tauri/icons
	magick /tmp/soksak-icon-master.png -fill '#2ec07a' -colorize 42% /tmp/soksak-icon-dev.png
	$(PNPM) tauri icon /tmp/soksak-icon-dev.png --output frameworks/tauri/icons-dev
	magick /tmp/soksak-icon-master.png -fill '#ff8c1a' -colorize 45% /tmp/soksak-icon-debug.png
	$(PNPM) tauri icon /tmp/soksak-icon-debug.png --output frameworks/tauri/icons-debug
	cp /tmp/soksak-icon-master.png frameworks/tauri/icons/icon.png   # 마스터 1024 복원(커밋되는 단일 원본)
	@rm -f /tmp/soksak-icon-master.png /tmp/soksak-icon-dev.png /tmp/soksak-icon-debug.png
	@echo "아이콘 재생성 완료: 마스터(1024 SVG벡터)+base+dev(녹색)+debug(주황)"

# 개발 볼트 — 키체인 프롬프트 없이 뜬다.
#
# tauri dev 는 매 변경마다 바이너리를 새로 만들고, macOS 키체인은 그때마다 다른 앱으로 보아
# 접근 승인을 다시 묻는다. 그 대화상자는 부팅 중간(setup 의 볼트 개방)에서 사람을 기다리므로
# 앱이 IPC 도 못 세운 채 멈춘다 — 개발이 사람 손을 기다리게 된다.
#
# 그래서 dev 는 주입 KEK(SOKSAK_E2E_KEK)를 쓴다. 이 경로는 #[cfg(debug_assertions)] 안에만
# 있어 릴리즈 바이너리엔 컴파일조차 되지 않는다(env-KEK 백도어 아님).
#
# 볼트 경로도 함께 옮긴다. KEK 불일치는 loud Err 로 끝나므로(다른 기기 키체인·리셋 신호를
# 삼키지 않는 설계) 키체인 볼트를 주입 KEK 로 열 수 없다 — 짝을 지어야 성립한다.
# 실볼트(~/.soksak-dev/secrets.vault)는 건드리지 않고 그대로 남는다.
DEV_KEK ?= soksak-dev-local
DEV_VAULT ?= $(HOME)/.soksak-dev/secrets.dev.vault

dev: cli-dev ## 개발 서버(HMR) + sok-dev. 키체인 프롬프트 없음(주입 KEK+전용 볼트). 플러그인은 ~/.soksak-dev/plugins 단일 폴더
	SOKSAK_E2E_KEK=$(DEV_KEK) SOKSAK_VAULT_PATH=$(DEV_VAULT) $(PNPM) tauri dev

dev-keychain: cli-dev ## 개발 서버 + 실볼트(키체인 프롬프트 있음). 실 시크릿이 필요한 검증용.
	$(PNPM) tauri dev

# 번들 빌드는 spec-gate 를 선행한다 — 코어 프론트는 @soksak-ai/plugin-spec·plugin-api 의 **dist** 를
# 소비하므로, 소스 타입만 고치고 dist 를 다시 안 빌드하면 tauri 의 pnpm build 가 옛 타입으로 깨진다
# (typecheck 는 소스를 보고 통과하므로 verify 는 놓친다 — 실측: consumes 추가 후 build-debug 만 실패).
build: spec-gate cli ## 릴리스 번들 빌드 → "soksak-tauri.app"(기본 아이콘) + sok; updater 공개키 필수
	node scripts/release/prepare-tauri-config.mjs --base $(RELEASE_CONFIG) --out $(RELEASE_CONFIG_GENERATED)
	CARGO_BUILD_TARGET=$(TAURI_TARGET) $(PNPM) tauri build --target $(TAURI_TARGET) --config $(RELEASE_CONFIG_GENERATED)

build-dev: spec-gate cli-dev ## 개발 정체성 앱 번들 → "soksak-tauri-dev.app" + soksak-cored
	CARGO_BUILD_TARGET=$(TAURI_TARGET) $(PNPM) tauri build --debug --bundles app --target $(TAURI_TARGET) --config $(DEV_BUNDLE_CONFIG)

build-debug: spec-gate cli-debug ## 디버그 번들 빌드 → "soksak-tauri-debug.app"(주황 아이콘) + sok-debug
	CARGO_BUILD_TARGET=$(TAURI_TARGET) $(PNPM) tauri build --debug --target $(TAURI_TARGET) --config $(DEBUG_CONFIG)

electron: ## Electron 프레임워크(Tauri 프레임워크와 형제 — 교체 아님). pnpm dev:electron(1422)이 떠 있어야 한다.
	@# 제품 번들로 실행한다 — macOS 는 앱의 정체(메뉴바·Dock·프로세스 이름)를 번들 Info.plist
	@# 에서 읽으므로, 프레임워크의 기본 번들로 돌면 이 제품이 "Electron" 으로 보인다.
	@APP=$$(frameworks/electron/bundle.sh com.soksak.electron.dev) && \
	  "$$APP/Contents/MacOS/$$(basename "$$APP" .app)" frameworks/electron/main.cjs

run: ## 릴리스 soksak-tauri.app 실행(새 인스턴스)
	@test -d "$(RELEASE_APP)" || { echo "먼저 'make build' 를 실행하세요."; exit 1; }
	open -n "$(RELEASE_APP)"

run-dev: ## 개발 정체성 soksak-tauri-dev.app 실행(새 인스턴스)
	@test -x "$(DEV_EXECUTABLE)" || { echo "먼저 'make build-dev' 를 실행하세요."; exit 1; }
	@mkdir -p "$(DEV_LOG_DIR)"
	@# macOS GUI 번들의 수명 주인은 호출 셸이 아니라 LaunchServices다. 실행물을 `&`/nohup으로
	@# 직접 띄우면 자동화 셸 종료와 함께 앱 호스트도 사라져 restart-dev가 거짓 성공한다.
	@# -g는 창을 전면으로 가져오지 않고, --env/-i/-o가 dev 정체성과 진단면을 그대로 보존한다.
	@open -n -g -i /dev/null \
	  -o "$(DEV_LOG_DIR)/tauri-app.log" --stderr "$(DEV_LOG_DIR)/tauri-app.error.log" \
	  --env SOKSAK_E2E_KEK=$(DEV_KEK) --env SOKSAK_VAULT_PATH=$(DEV_VAULT) \
	  "$(DEV_APP)"
	@echo "실행: $(DEV_APP) (로그: $(DEV_LOG_DIR)/tauri-app.log, tauri-app.error.log)"

rebuild-dev: build-dev ## 현재 소스를 dev 번들로 다시 만든 뒤 단일 인스턴스로 재실행
	$(MAKE) --no-print-directory restart-dev

restart-dev: ## 이미 빌드·검증된 동일 dev 번들을 빌드 없이 반복 재실행
	@test -x "$(DEV_EXECUTABLE)" -a -x "$(DEV_CLI)" || { echo "먼저 'make build-dev' 를 실행하세요."; exit 1; }
	@CLI="$(DEV_CLI)"; SOCKET="$(DEV_HOST_SOCKET)"; \
	owner_pid() { lsof -t "$$SOCKET" 2>/dev/null | head -n 1; }; \
	host_ready() { "$$CLI" window.list >/dev/null 2>&1; }; \
	old_pid="$$(owner_pid)"; \
	if [ -n "$$old_pid" ] && host_ready; then \
	  "$$CLI" app.quit >/dev/null || { echo "app.quit 실패"; exit 1; }; \
	fi; \
	if [ -n "$$old_pid" ]; then \
	  for _ in $$(seq 1 100); do kill -0 "$$old_pid" 2>/dev/null || break; sleep 0.1; done; \
	  kill -0 "$$old_pid" 2>/dev/null && { echo "종료 실패: dev IPC 소유 PID $$old_pid 가 남았다"; exit 1; }; \
	fi; \
	$(MAKE) --no-print-directory run-dev >/dev/null; \
	new_pid=""; \
	for _ in $$(seq 1 300); do \
	  new_pid="$$(owner_pid)"; \
	  [ -n "$$new_pid" ] && [ "$$new_pid" != "$$old_pid" ] && kill -0 "$$new_pid" 2>/dev/null && host_ready && break; \
	  sleep 0.1; \
	done; \
	[ -n "$$new_pid" ] && [ "$$new_pid" != "$$old_pid" ] && kill -0 "$$new_pid" 2>/dev/null && host_ready || \
	  { echo "재실행 준비 실패: dev IPC 소유 프로세스가 교체되어 응답하지 않는다"; exit 1; }; \
	sleep 0.5; \
	[ "$$(owner_pid)" = "$$new_pid" ] && kill -0 "$$new_pid" 2>/dev/null || \
	  { echo "재실행 수명 실패: 새 dev PID $$new_pid 가 유지되지 않는다"; exit 1; }; \
	echo "재실행: dev PID $$old_pid → $$new_pid, 창 호스트 준비 완료"

run-debug: ## 디버그 soksak-tauri-debug.app 실행(새 인스턴스)
	@test -d "$(DEBUG_APP)" || { echo "먼저 'make build-debug' 를 실행하세요."; exit 1; }
	open -n "$(DEBUG_APP)"

# CLI 는 앱과 환경 짝으로 빌드된다(busybox 패턴 — 1 소스 바이너리, 설치명이 곧 환경: argv0 디스패치).
# release→sok / debug 프로파일→sok-dev·sok-debug. cp 로 환경명 사본 생성(앱과 함께 빌드, 사용자 지시).
cli: ## sok CLI(release 환경) — 빌드가 환경을 선택한다: 이 빌드는 sok 하나를 떨군다(P9)
	cd frameworks/tauri && cargo build --release -p sok --bin sok

cli-dev: ## sok-dev CLI(dev 환경, debug 프로파일) — 이 빌드는 sok-dev 하나를 떨군다(P9)
	cd frameworks/tauri && cargo build -p sok --bin sok-dev

cli-debug: ## sok-debug CLI(debug 환경, debug 프로파일) — 이 빌드는 sok-debug 하나를 떨군다(P9)
	cd frameworks/tauri && cargo build -p sok --bin sok-debug

install-cli: cli ## sok(release) regular binary를 /usr/local/bin에 원자 설치(멱등)
	@mkdir -p /usr/local/bin 2>/dev/null || true
	@bash scripts/install/install-regular-file.sh "$(CARGO_TARGET)/release/sok" /usr/local/bin/sok
	@echo "설치 완료: /usr/local/bin/sok (release regular binary)"

install-cli-dev: cli-dev ## sok-dev regular binary를 /usr/local/bin에 원자 설치
	@mkdir -p /usr/local/bin 2>/dev/null || true
	@bash scripts/install/install-regular-file.sh "$(CARGO_TARGET)/debug/sok-dev" /usr/local/bin/sok-dev
	@echo "설치 완료: /usr/local/bin/sok-dev (dev regular binary)"

install-cli-debug: cli-debug ## sok-debug regular binary를 /usr/local/bin에 원자 설치
	@mkdir -p /usr/local/bin 2>/dev/null || true
	@bash scripts/install/install-regular-file.sh "$(CARGO_TARGET)/debug/sok-debug" /usr/local/bin/sok-debug
	@echo "설치 완료: /usr/local/bin/sok-debug (debug regular binary)"

# 컨트롤 플레인(main)에 묻는다 — 명령 표면은 창마다 다르다. 워크스페이스 창에는 orchestrator.*
# 가 등록되지 않으므로(그 창에선 UNKNOWN_COMMAND 가 정답), 창을 안 집으면 아무 창이나 답해
# 그 명령들이 조용히 빠진 문서가 나온다(실측 2026-08-02). 게이트
# command-reference-whole-surface 가 그런 문서를 거절한다.
docs: ## 명령 레퍼런스 생성(docs/COMMANDS.md — 앱이 실행 중이어야 함)
	@mkdir -p docs
	@set -eu; \
	tmp="$$(mktemp "$$(pwd)/docs/.COMMANDS.md.XXXXXX")"; \
	cleanup() { case "$$tmp" in "$$(pwd)"/docs/.COMMANDS.md.*) rm -f -- "$$tmp" ;; esac; }; \
	trap cleanup EXIT; \
	$(or $(DOCS_SOK),$(CARGO_TARGET)/release/sok) --window main docs --core > "$$tmp"; \
	mv -- "$$tmp" docs/COMMANDS.md; \
	trap - EXIT
	@echo "생성: docs/COMMANDS.md"

docs-dev: cli-dev ## dev 앱의 실제 command catalog로 명령 레퍼런스 생성
	@mkdir -p docs
	@set -eu; \
	tmp="$$(mktemp "$$(pwd)/docs/.COMMANDS.md.XXXXXX")"; \
	cleanup() { case "$$tmp" in "$$(pwd)"/docs/.COMMANDS.md.*) rm -f -- "$$tmp" ;; esac; }; \
	trap cleanup EXIT; \
	SOKSAK_SOCKET="$(DEV_CORED_SOCKET)" "$(DEV_CLI)" --window main docs --core > "$$tmp"; \
	mv -- "$$tmp" docs/COMMANDS.md; \
	trap - EXIT
	@echo "생성(dev): docs/COMMANDS.md"

# 발행(plugin-publish)은 코어에 두지 않는다(P1·P3) — 각 플러그인은 자기 독립 repo 에서
# 직접 커밋·태그·push 한다. 카탈로그 갱신(각 repo plugin.json → registry.json)은
# soksak-plugin-registry repo 가 소유한다.

registry: ## 레지스트리 카탈로그 스냅샷 갱신 — 라이브 registry.json 을 fetch 해 캐시(P2 소비). 멱등
	@curl -fsSL "$(REGISTRY_URL)" -o src/plugins/registrySnapshot.json
	@echo "레지스트리 스냅샷: src/plugins/registrySnapshot.json ($$(jq '.plugins | length' src/plugins/registrySnapshot.json)개, 라이브 fetch)"

typecheck: ## 프론트엔드 타입 체크(tsc)
	$(PNPM) exec tsc --noEmit

check: ## Rust 컴파일 체크(cargo check)
	cd frameworks/tauri && cargo check

test: ## Rust 단위 테스트
	cd frameworks/tauri && cargo test --workspace

test-front: ## 프론트엔드 단위 테스트(vitest)
	$(PNPM) test

spec-gate: ## 패키지 빌드(plugin-spec·plugin-api dist — 코어가 소비) + 헤드리스 스키마 게이트
	@npx tsc -p packages/plugin-spec/tsconfig.json
	@npx tsc -p packages/plugin-api/tsconfig.json
	@node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/valid/plugin.json
	@node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/valid-implements/plugin.json
	@node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/valid-service/plugin.json
	@node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/valid-viewcontract/plugin.json
	@node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/c2-clean/plugin.json
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/c2-status-undeclared/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: status 미선언 콘텐츠 뷰가 통과됨(content-view-status blocking 게이트 깨짐)"; exit 1; \
	else true; fi
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/invalid/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: 무효 매니페스트가 통과됨(게이트 깨짐)"; exit 1; \
	else true; fi
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/invalid-implements/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: 무효 implements 계약 id 가 통과됨(게이트 깨짐)"; exit 1; \
	else true; fi
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/invalid-viewcontract/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: 무효 viewContract 계약 id 가 통과됨(게이트 깨짐)"; exit 1; \
	else true; fi
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/invalid-service/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: service 없는 entry:null 이 통과됨(PS4 게이트 깨짐)"; exit 1; \
	else true; fi
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/invalid-status/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: 무효 status 선언이 통과됨(게이트 깨짐)"; exit 1; \
	else true; fi
	@if node packages/plugin-spec/bin/validate.mjs packages/plugin-spec/test/fixtures/c2-static-violation/plugin.json >/dev/null 2>&1; then \
		echo "spec-gate: C2 blocking 위반 매니페스트가 통과됨(게이트 깨짐)"; exit 1; \
	else echo "✓ spec-gate(빌드+무효 거부+C2 판정 확인)"; fi

doctor: ## 작업 공간 진단 — 워크트리가 정본의 target·node_modules 를 공유하는가, 디스크 여유는 충분한가
	@node scripts/diag/workspace-doctor.mjs

doctor-fix: ## 위 진단을 고친다(멱등 — 몇 번을 돌려도 같은 상태로 수렴한다)
	@node scripts/diag/workspace-doctor.mjs --fix

gates: ## 코어 규율 게이트(blocking) — 디렉터리에서 **발견해** 전부 돌린다. 판정은 종료코드다
	@node scripts/gates/run-all.mjs
	@node scripts/e2e/framework-binding.mjs --check

e2e-framework-binding: ## e2e 하니스의 프레임워크 결속 분류(A 프레임워크무관·B 경로결속·C 네이티브)를 읽는다. 하니스를 돌리지 않는다
	@node scripts/e2e/framework-binding.mjs $(ARGS)

e2e-slot-freeze-dev: build-dev restart-dev ## 현재 소스로 dev 앱 빌드·재시작→실제 탭 교차 클릭·연속 캡처
	@SOKSAK_SOCKET="$(DEV_CORED_SOCKET)" node scripts/e2e/slot-freeze.mjs

e2e-titlebar-dev: build-dev ## 현재 소스를 한 번 빌드하고 냉재시작 3회×모든 창×높이 3종의 B12를 기계 판정·캡처
	@for cycle in 1 2 3; do \
		$(MAKE) --no-print-directory restart-dev || exit 1; \
		SOKSAK_SOCKET="$(DEV_CORED_SOCKET)" B12_CYCLE="$$cycle" node scripts/e2e/titlebar-composition.mjs || exit 1; \
	done

gates-registry: ## 배포 카탈로그 권위 게이트(네트워크) — 라이브 registry.json 의 GitHub 매니페스트 실측. C2 승격 소용돌이(시행 모집단=측정 모집단) + 의존 그래프 충족(의존 대상이 카탈로그에 함께 배포되는가) + 계약 동기(doctor 발행본 ≡ 코어 contract). 발행 전 GREEN 필수. 로컬(make gates)은 개발 사전점검일 뿐.
	@node scripts/gates/c2-transparency-scan.mjs --registry
	@node scripts/gates/dependency-graph-scan.mjs
	@node scripts/gates/contract-sync-scan.mjs

verify: spec-gate gates typecheck check test test-front ## 헤드리스 게이트(spec 빌드+규율 게이트) + 타입체크 + Rust/프론트 테스트(커밋 전 검증)

test-unit: spec-gate gates typecheck check test test-front ## 결정적 단위(LLM 0·앱 불요) — 전 repo 표준 타깃(docs/TESTING.md)

test-e2e: ## 실행 중 앱 대상 E2E 스위트(멱등·자기정리). IDENTITY 기본 debug. 앱 실행+전면 필요
	@# 주소는 **cored 소켓**이다 — 프레임워크의 앱 소켓을 쓰면 그 프레임워크만 검증한다.
	@# cored 는 그 창을 든 쪽으로 배달하므로, 어느 프레임워크가 떠 있든 같은 명령이 닿는다.
	@# 실측 2026-08-01: 앱 소켓을 기본으로 두는 동안 Electron 은 매번 검증에서 빠졌고, 그
	@# 프레임워크에서만 죽는 결함 둘(워크스페이스 저장·제어면 재접속)이 그대로 살아 있었다.
	@IDENTITY=$${IDENTITY:-debug}; \
	fail=0; \
	for h in orchestrator project-rail nl-console browser-restore; do \
		echo "── e2e: $$h ──"; bash scripts/e2e/$$h.sh --identity $$IDENTITY || fail=1; \
	done; \
	echo "── e2e: multiwindow ──"; SOKSAK_SOCKET="$$HOME/.soksak-$$IDENTITY/cored.sock" node scripts/e2e/multiwindow.mjs || fail=1; \
	echo "── e2e: slot-freeze ──"; SOKSAK_SOCKET="$$HOME/.soksak-$$IDENTITY/cored.sock" node scripts/e2e/slot-freeze.mjs || fail=1; \
	echo "── e2e: ui-verify ──"; SOKSAK_SOCKET="$$HOME/.soksak-$$IDENTITY/cored.sock" node scripts/e2e/ui-verify.mjs || fail=1; \
	echo "── e2e: browser-pixels ──"; SOKSAK_SOCKET="$$HOME/.soksak-$$IDENTITY/cored.sock" node scripts/e2e/browser-pixels.mjs || fail=1; \
	echo "── e2e: gutter-hover ──"; SOKSAK_SOCKET="$$HOME/.soksak-$$IDENTITY/cored.sock" node scripts/e2e/gutter-hover.mjs || fail=1; \
	for m in surface-park tab-switch-ghost restore-load motion-slow restore-timing snapshot-generation; do \
		echo "── e2e: $$m ──"; SOKSAK_SOCKET="$$HOME/.soksak-$$IDENTITY/cored.sock" node scripts/e2e/$$m.mjs || fail=1; \
	done; \
	echo "── e2e: resize ──"; bash scripts/e2e/resize.sh --identity $$IDENTITY || fail=1; \
	[ $$fail = 0 ] && echo "✓ test-e2e 전체 GREEN" || { echo "✗ test-e2e 실패"; exit 1; }

e2e-resize: ## 리사이즈 E2E(기계 측정 — blank/프롬프트/TUI). macOS+앱 실행+동의 필요
	scripts/e2e/resize.sh --identity $${IDENTITY:-dev}

perf-gate: ## 터미널 성능 게이트(W4) — 게이트 자체검증 후 t1/t2/t5/t6 실측 → budgets.json 위반 시 실패. 앱 실행+전면 필요
	@$(PNPM) vitest run scripts/perf/check-budgets.test.mjs
	@bash scripts/perf/run-t.sh --identity $${IDENTITY:-debug} --label gate --t1mb $${T1MB:-100}

clean: ## dev 에 불필요한 재생성 산출물 제거(release 프로파일·번들·dist). 증분 빌드 자산(deps/.fingerprint/build/incremental/바이너리)은 보존 — 다음 dev 빌드 영향 0
	cd frameworks/tauri && cargo clean --release
	rm -rf dist $(CARGO_TARGET)/debug/bundle

clean-deep: clean ## clean + 증분 컴파일 캐시(target/debug/incremental) 제거. deps 는 유지하나 다음 빌드 때 앱 크레이트만 전체 재컴파일(deps 재컴파일 X). 디스크 압박 시만
	rm -rf $(CARGO_TARGET)/debug/incremental

clean-orphan-target: ## 옛 워크스페이스 뿌리가 남긴 고아 산출물 제거($(ORPHAN_TARGET))
	@# 워크스페이스 뿌리가 저장소 루트로 옮겨간 뒤 이 자리는 cargo 가 더는 쓰지 않는다.
	@# 그런데 옛 산출물이 남아 있어서, 손으로 그 경로를 치면 조용히 옛 바이너리가 잡힌다
	@# (실측 2026-08-01: 7/28 sok-dev 로 검증해 이미 고친 결함이 살아 있다는 답을 받았다).
	@#
	@# 지우기 전에 **cargo 가 그 자리를 안 쓴다는 것**을 확인한다 — 뿌리가 되돌아왔는데
	@# 지우면 그것은 살아 있는 산출물을 지우는 것이다.
	@test "$(CARGO_TARGET)" != "$(CURDIR)/$(ORPHAN_TARGET)" || \
	  { echo "거부: cargo 가 이 자리를 쓴다 — 고아가 아니다"; exit 1; }
	@if [ -d $(ORPHAN_TARGET) ]; then \
	  echo "제거: $(ORPHAN_TARGET) ($$(du -sh $(ORPHAN_TARGET) | cut -f1))"; \
	  rm -rf $(ORPHAN_TARGET); \
	else echo "없음: $(ORPHAN_TARGET) (이미 정리됨)"; fi

stop: ## 실행 중인 개발 스택 전체 종료(tauri 바이너리 + tauri.js dev + Vite)
	@pkill -f "target/debug/soksak-dev" 2>/dev/null || true
	@pkill -f "node_modules/.*tauri.js dev" 2>/dev/null || true
	@# tauri.js dev 가 죽어도 beforeDevCommand 로 띄운 Vite(devUrl 포트 1420)는 고아로
	@# 남는다 — devUrl 포트를 점유한 프로세스를 정리해 clean stop 을 보장한다.
	@pids=$$(lsof -ti :1420 2>/dev/null); [ -n "$$pids" ] && kill $$pids 2>/dev/null || true
	@echo "개발 서버 종료(tauri + Vite)."

# 사이드카 소스 = 독립 repo(단일진실), 홈 = ~/.soksak/sidecars/<이름>(플러그인 단일 폴더 모델과 동형).
SIDECAR_BROWSER_CHROMIUM_HOME := $(HOME)/.soksak/sidecars/soksak-sidecar-browser-chromium

sidecar-browser-chromium: ## Chromium 엔진 사이드카 빌드+스테이지(dev) — 소스·dist 모두 사이드카 홈
	@test -d "$(SIDECAR_BROWSER_CHROMIUM_HOME)/src" || { echo "사이드카 소스 없음 — git clone https://github.com/soksak-ai/soksak-sidecar-browser-chromium \"$(SIDECAR_BROWSER_CHROMIUM_HOME)\""; exit 1; }
	cd "$(SIDECAR_BROWSER_CHROMIUM_HOME)" && cargo build --release && ./stage.sh dist
sidecar-browser-chromium-archive: sidecar-browser-chromium ## 배포 아카이브(regular file 전용 staging) + sha256
	@root="$$HOME/.soksak/sidecars/soksak-sidecar-browser-chromium"; \
	ver=$$(grep '^version' "$(SIDECAR_BROWSER_CHROMIUM_HOME)/Cargo.toml" | head -1 | sed 's/.*"\(.*\)"/\1/'); \
	out="$(SIDECAR_BROWSER_CHROMIUM_HOME)/target/soksak-sidecar-browser-chromium-$$ver-darwin-arm64.tar.gz"; \
	bash scripts/release/archive-regular-files.sh "$$root/dist" "$$out"; \
	echo "아카이브: $$out"; \
	shasum -a 256 "$$out" | awk '{print "sha256: "$$1}'
