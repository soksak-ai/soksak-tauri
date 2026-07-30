//! soksak-cored 를 **값으로** 노출한다 — 서빙 표는 코드를 읽어야 아는 것이 아니라
//! 물어서 아는 것이고(R7), 물어보는 쪽에는 앱의 테스트도 포함된다.
//!
//! 바이너리만 있던 동안 "cored 가 무엇을 어떤 모양으로 서빙하는가"는 프로세스를 띄워야만
//! 알 수 있었다. 그래서 표와 앱 명령 사이의 모양 어긋남이 **런타임에만**, 그것도
//! INVALID_PARAMS 라는 한 줄로만 드러났다(2026-07-28 실측: 서빙한다고 믿은 5개가 전부
//! 이 상태였다). 라이브러리로 세우면 그 대조가 컴파일 대상이 된다.

pub mod control;
pub mod ctx;
pub mod pty;
pub mod streams;
pub mod ledger;
pub mod registry;
// 명령 표 — 선언만 산다(몸은 registry.rs).
pub mod registry_table;
// WebSocket 명령의 몸 — 표와 갈라 둔다.
pub mod registry_ws;
// 거절 사유 표 — 사유가 코드보다 길어 따로 산다(registry.rs 가 재수출한다).
pub mod unserved;
pub mod wire;
