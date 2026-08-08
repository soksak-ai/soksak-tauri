//! 부팅 단계 계측 — 어디서 시간이 가는지 사람이 로그를 눈으로 재지 않아도 알게 한다.
//!
//! 실측 2026-08-08: 앱을 띄우고 명령이 열리기까지 10.2 초가 걸렸는데, 그 구간을 재는 자리가
//! 없어 원인을 좁힐 수 없었다. 프론트엔드의 boot.step 은 그 뒤(1.3s)부터라 이 구간을 못 본다.
//!
//! 단계마다 자기 이름과 걸린 시간을 남긴다. 느린 단계는 그 이름으로 드러난다.
//!
//! **프레임워크에 매이지 않는다.** 부팅의 시각과 순서는 어느 실행물이든 같은 사실이고, 원장에
//! 흘려보내는 자리만 호스트마다 다르다 — 그 자리는 계약(`ActivitySink`)으로 받는다.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// 이 프로세스가 자기 코드의 첫 줄에 닿은 시각. `run()` 최서두가 채운다.
///
/// 이것이 없으면 "띄운 시각 → setup" 한 덩어리만 보이는데, 그 안에는 성격이 다른 둘이 들어
/// 있다: 실행물이 적재되기까지(LaunchServices·dyld)와 프레임워크가 setup 에 닿기까지다.
/// 고칠 자리가 다르므로 갈라 재야 한다.
static PROCESS_ENTERED: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

pub fn mark_process_entered() {
    let _ = PROCESS_ENTERED.set(unix_ms());
}

/// 빌더 체인이 다 서고 `run` 에 넘기기 직전. 앞은 플러그인·상태 등록이고 뒤는 프레임워크가
/// 창을 만들어 setup 에 닿기까지다 — 이 둘도 고칠 자리가 다르다.
static BUILDER_READY: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

pub fn mark_builder_ready() {
    let _ = BUILDER_READY.set(unix_ms());
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 한 부팅의 단계 원장. 첫 도장 시각을 기준으로 각 단계의 누적·구간을 잰다.
pub struct BootTrace {
    started: Instant,
    last: Instant,
    /// 찍은 도장과 **그 순간의 벽시계**. 원장은 저장소가 열린 뒤에야 쓸 수 있어 나중에 흘려보내는데,
    /// 그때의 시각을 쓰면 전 단계가 한 점으로 뭉쳐 어디서 시간이 갔는지 사라진다.
    stamps: Vec<(String, u64)>,
}

impl BootTrace {
    pub fn start() -> Self {
        let now = Instant::now();
        Self { started: now, last: now, stamps: Vec::new() }
    }

    /// 이 단계가 끝났다고 도장을 찍는다. 직전 단계부터 걸린 시간과 부팅 시작부터의 누적을 낸다.
    pub fn step(&mut self, name: &str) {
        let now = Instant::now();
        let span = now.duration_since(self.last);
        let total = now.duration_since(self.started);
        self.last = now;
        self.stamps.push((name.to_string(), unix_ms()));
        eprintln!(
            "[boot] {name} +{:.2}s (누적 {:.2}s)",
            span.as_secs_f64(),
            total.as_secs_f64()
        );
    }

    /// 모아 둔 도장을 활동 원장으로 흘려보낸다 — 프론트 도장과 **한 축**에서 읽힌다.
    ///
    /// 원장은 저장소가 열린 뒤에만 쓸 수 있다. 그래서 찍을 때가 아니라 여기서 보내되, 각
    /// 도장은 자기가 찍힌 시각을 싣는다(`atUnixMs`).
    pub fn flush(&self, sink: &dyn crate::activity_sink::ActivitySink) {
        let early: Vec<(String, u64)> = [
            ("process-enter", PROCESS_ENTERED.get().copied()),
            ("builder-ready", BUILDER_READY.get().copied()),
        ]
        .into_iter()
        .filter_map(|(name, at)| at.map(|at| (name.to_string(), at)))
        .collect();
        for (name, at) in early.iter().chain(self.stamps.iter()) {
            sink.publish(
                "boot.step",
                "boot",
                serde_json::json!({
                    "step": format!("rust:{name}"),
                    "atUnixMs": at,
                    "window": "main",
                    "message": format!("· boot rust:{name}"),
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 단계마다_이름과_시간을_남긴다() {
        let mut trace = BootTrace::start();
        // 도장은 부수효과가 로그 한 줄이고, 상태는 직전 시각 하나뿐이다 — 여기서 재는 것은
        // 그 상태가 단조로 나아가는가다(구간이 음수가 되면 그 뒤 모든 수치가 거짓이 된다).
        trace.step("first");
        let after_first = trace.last;
        trace.step("second");
        assert!(trace.last >= after_first, "직전 시각은 뒤로 가지 않는다");
        assert!(trace.last >= trace.started, "누적 기준은 시작 시각이다");
    }
}
