//! 임베디드 데이터 스토어의 **규칙과 질의문**.
//!
//! 코어(soksak-core)에 못 사는 이유는 rusqlite 하나다 — 코어는 무의존을 지킨다. 저장소는
//! 프레임워크가 아니라 자원이므로, 그 자원을 지는 프로세스들이 이 크레이트를 함께 쓴다.

pub mod doc;
pub mod integrity;
pub mod ids;
pub mod store;

pub use ids::{gen_id, now_millis, validate_coll, validate_field};
