//! 프레임워크가 들어 있지 않은 명령 로직.
//!
//! 여기 있는 것은 앱 프로세스에서 돌든 cored 프로세스에서 돌든 **같은 답**을 낸다.
//! 그 조건은 셋이다:
//!   - 창·앱 핸들·관리 상태를 만지지 않는다
//!   - 프로세스 환경(`env::var`)·현재 디렉터리·실행 파일 경로를 읽지 않는다
//!   - 컴파일 타깃·빌드 프로파일을 값의 근거로 삼지 않는다(자기 서술 금지)
//!
//! 셋째가 특히 조용하다: `cfg!(target_os)` 로 답이 갈리는 함수는 "이 바이너리가 무엇인가"를
//! 말하는 것이지 호출자가 물은 것을 말하는 게 아니다. 플랫폼별 분기가 필요하면 **타깃을
//! 인자로 받는다**.
//!
//! 이 규칙은 문서가 아니라 게이트가 시행한다(`tests/no_framework.rs` — 의존 트리와 심볼을
//! 함께 훑는다). 새 코드를 여기 넣기 전에 그 게이트를 먼저 읽어라.
//!
//! 이름이 `core` 인 이유: 이 크레이트는 **아닌 것**(프레임워크에 안 묶임)이 아니라 **인 것**으로
//! 불려야 한다. 앱도 cored 도 여기 있는 로직을 자기 것으로 부르고, 둘 다 이것 없이는
//! 아무 명령도 답하지 못한다.

pub mod activity;
pub mod activity_sink;
// 부팅 단계 계측 — 시각과 순서는 프레임워크 무관이고, 흘려보낼 자리만 계약으로 받는다.
pub mod boot_trace;
// 네이티브 창의 최초 표시 게이트 — 만드는 방법은 프레임워크, 보여도 되는가는 규칙이다.
pub mod window_startup;
pub mod ambient_gate;
pub mod control;
pub mod fsx;
pub mod geometry;
pub mod host_slot;
pub mod identity;
pub mod artifact_integrity;
pub mod deeplink;
pub mod data_change;
pub mod kv;
pub mod pathx;
pub mod shell_env;
pub mod shellq;
pub mod plugin_data;
pub mod plugin_dir;
pub mod probe;
pub mod proc;
pub mod pty_delivery;
#[cfg(unix)]
pub mod ptyd;
pub mod seal_keys;
pub mod secret_env;
pub mod session;
pub mod skillgen;
pub mod file_lock;

pub mod project_registry;
pub mod store_lock;
pub mod window_census;
pub mod store_open;
pub mod stream;
pub mod stream_sink;
pub mod themes;
pub mod udp;
pub mod unit_dev;
pub mod unit_target;
pub mod window_spec;
pub mod window_traces;
pub mod surface_spec;
pub mod native_surface_ledger;
// 예약 명세 — 스케줄러와 서비스 원장이 공유하는 순수 타입.
pub mod schedule_spec;
// 명령 중개 계약 — 부르는 쪽이 창을 모르게 한다.
pub mod command_dispatch;
pub mod cored_probe;
