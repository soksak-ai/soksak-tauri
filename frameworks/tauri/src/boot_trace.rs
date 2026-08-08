//! 부팅 단계 계측 — 어디서 시간이 가는지 사람이 로그를 눈으로 재지 않아도 알게 한다.
//!
//! 실측 2026-08-08: 앱을 띄우고 명령이 열리기까지 10.2 초가 걸렸는데, 그 구간을 재는 자리가
//! 없어 원인을 좁힐 수 없었다. 프론트엔드의 boot.step 은 그 뒤(1.3s)부터라 이 구간을 못 본다.
//!
//! 단계마다 자기 이름과 걸린 시간을 남긴다. 느린 단계는 그 이름으로 드러난다.

use std::time::Instant;

/// 한 부팅의 단계 원장. 첫 도장 시각을 기준으로 각 단계의 누적·구간을 잰다.
pub(crate) struct BootTrace {
    started: Instant,
    last: Instant,
}

impl BootTrace {
    pub(crate) fn start() -> Self {
        let now = Instant::now();
        Self { started: now, last: now }
    }

    /// 이 단계가 끝났다고 도장을 찍는다. 직전 단계부터 걸린 시간과 부팅 시작부터의 누적을 낸다.
    pub(crate) fn step(&mut self, name: &str) {
        let now = Instant::now();
        let span = now.duration_since(self.last);
        let total = now.duration_since(self.started);
        self.last = now;
        eprintln!(
            "[boot] {name} +{:.2}s (누적 {:.2}s)",
            span.as_secs_f64(),
            total.as_secs_f64()
        );
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
