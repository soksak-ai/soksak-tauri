//! 임베디드 데이터 스토어의 **규칙과 질의문**.
//!
//! 코어(soksak-core)에 못 사는 이유는 rusqlite 하나다 — 코어는 무의존을 지킨다. 저장소는
//! 프레임워크가 아니라 자원이므로, 그 자원을 지는 프로세스들이 이 크레이트를 함께 쓴다.

pub mod backup;
pub mod data_keys;
pub mod doc;
pub mod ids;
pub mod integrity;

pub mod encryption;

pub mod write_policy;
pub mod open;
pub mod ring;
pub mod kv_conn;
pub mod store;
// 활동 원장의 영속 — 적재하는 모든 프로세스가 지나는 한 자리(규칙은 core, 쓰기는 여기).
pub mod activity_persist;

pub use ids::{gen_id, now_millis, validate_coll, validate_field};
// AI 세션 계보 — 조회 한 경로.
pub mod session_lineage;
