use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use objc2_quartz_core::CACurrentMediaTime;

/// 이 시계의 이름 — "unix 로 한 번 고정하고, 그 뒤로는 monotonic 표시 시계로만 나아간다".
///
/// `...UnixMs` 라는 접미사는 같은 시계를 뜻하지 않는다. 이 원장의 시각을 다른 producer 의 시각과
/// 한 축에서 비교하려면 둘 다 이 이름을 답해야 한다. 이름은 프레임워크를 안 싣는다 — 프론트엔드의
/// `src/lib/presentationClock.ts` 가 같은 성질의 시계를 같은 이름으로 답한다.
pub(crate) const PRESENTATION_CLOCK: &str = "unix-anchored-monotonic";

// SystemTime과 Core Animation media time의 관계는 프로세스에서 하나만 소유한다. 서로
// 다른 거래/계측 경로가 각자 `now` 두 개를 빼서 원점을 만들면 호출 간격만큼 같은 표시
// epoch가 갈라진다. 두 media sample의 중점을 사용해 최초 측정 오차도 한쪽으로 치우치지 않는다.
static UNIX_FROM_MEDIA_MS: OnceLock<f64> = OnceLock::new();

fn unix_now_raw_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn unix_from_media_ms() -> f64 {
    *UNIX_FROM_MEDIA_MS.get_or_init(|| {
        let media_before_ms = CACurrentMediaTime() * 1000.0;
        let unix_ms = unix_now_raw_ms();
        let media_after_ms = CACurrentMediaTime() * 1000.0;
        unix_ms - (media_before_ms + media_after_ms) / 2.0
    })
}

pub(super) fn unix_now_ms() -> f64 {
    // arm과 display callback이 반드시 같은 monotonic 원점을 사용한다. SystemTime을 다시
    // 읽으면 실행 중 NTP/수동 시각 보정 뒤 armedAt과 CADisplayLink epoch가 갈라진다.
    unix_ms_from_media_time(CACurrentMediaTime())
}

pub(super) fn media_time_from_unix_ms(unix_ms: f64) -> f64 {
    (unix_ms - unix_from_media_ms()) / 1000.0
}

pub(super) fn unix_ms_from_media_time(media_time: f64) -> f64 {
    unix_from_media_ms() + media_time * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arm_now와_display_timestamp는_같은_monotonic_epoch를_쓴다() {
        let before = CACurrentMediaTime();
        let armed = unix_now_ms();
        let after = CACurrentMediaTime();
        assert!(armed >= unix_ms_from_media_time(before));
        assert!(armed <= unix_ms_from_media_time(after));
    }
}
