//! 명령 중개 계약 — "registry 명령 하나를 부르고 답을 받는다".
//!
//! 이 계약은 창을 모른다. 어느 창으로 갈지(폴백 사다리)는 프레임워크의 것이고 부르는 쪽은
//! 명령과 답만 안다 — 창 사실이 필요한 호출자는 WindowOracle 을 따로 받는다. 여기 끼워 넣으면
//! 중개 계약이 라우팅 정책까지 쥐고, 구현마다 사다리가 갈라진다.
//!
//! 계약이 있는 이유: 명령 하나를 부르고 싶을 뿐인 발화기(스케줄러)가 앱 핸들을 쥐면, 그 코드는
//! 앱 프로세스를 떠날 수 없다.

use serde_json::Value;
use std::sync::mpsc::Receiver;

/// registry 명령의 중개자. 구현은 호스트마다 하나다.
pub trait CommandDispatch: Send + Sync {
    /// 한 번의 요청-응답. 상한 안에 답이 없으면 구현이 그 사실을 봉투로 말한다(무한대기 금지).
    fn request(
        &self,
        method: String,
        params: Value,
        timeout_ms: u64,
        origin: Option<&str>,
        key: Option<String>,
    ) -> Value;

    /// 대기를 호출자가 소유하는 발화 — (seq, 답 채널). 배달 실패면 None.
    /// 호출자는 끝날 때 반드시 `close(seq)` 로 자리를 회수한다.
    fn open(&self, method: String, params: Value, origin: Option<&str>)
        -> Option<(u64, Receiver<Value>)>;

    /// 대기 자리 회수(멱등) — 정상 완료·포기·취소 공용.
    fn close(&self, seq: u64);
}
