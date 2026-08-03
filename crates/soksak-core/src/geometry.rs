// 화면 기하 — 창이 **어느 모니터에 있는가**.
//
// 이 판정이 두 벌이면 같은 창을 프레임워크마다 다른 모니터로 답한다. 그 어긋남은 오류가
// 아니라 "저 창이 저기 있다는데 화면엔 여기 있다"로 나타나고, 자동화가 그 답으로 창을 옮기면
// 엉뚱한 화면에 놓인다.
//
// 값은 인자다: 모니터 사각형과 창 사각형만 받는다. 화면을 **읽는** 일은 프레임워크가 한다
// (Tauri 는 available_monitors, Electron 은 screen.getAllDisplays) — 규칙은 그것을 모른다.
//
// 좌표계는 물리 px 한 벌이다(window_place 와 같은 공간). 논리 px 를 섞으면 배율이 다른
// 모니터에서 판정이 뒤집힌다.

/// 사각형 하나 — 왼쪽 위 모서리와 크기.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    /// 중심점. 짝수가 아니어도 한 점으로 정해진다 — 나머지는 버린다(양쪽이 같은 답을 내려면
    /// 버리는 방향까지 같아야 한다).
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }

    /// 이 점이 이 사각형 안인가. 오른쪽·아래 경계는 **밖**이다 — 두 모니터가 맞닿은 자리에서
    /// 한 점이 양쪽에 속하면 소속이 목록 순서에 따라 흔들린다.
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// 이 창은 어느 모니터의 것인가 — **중심점 기준 단일 판정**.
///
/// 경계를 걸친 창도 하나로 정해진다. 겹치는 넓이로 고르면 같은 창이 픽셀 하나 움직일 때마다
/// 소속을 바꾸고, 그 흔들림은 창 배치 자동화에서 "가끔 다른 화면에 뜬다"로 나타난다.
///
/// 어느 모니터에도 안 들어가면 None 이다(화면 밖으로 나간 창) — 0 번으로 떨어뜨리지 않는다:
/// 그 0 은 "첫 모니터에 있다"와 구분되지 않는다.
pub fn monitor_of(window: Rect, monitors: &[Rect]) -> Option<usize> {
    let (cx, cy) = window.center();
    monitors.iter().position(|m| m.contains(cx, cy))
}

/// 사각형 네 성분에 같은 배율을 적용한다.
pub fn scale_rect(rect: (f64, f64, f64, f64), factor: f64) -> (f64, f64, f64, f64) {
    (rect.0 * factor, rect.1 * factor, rect.2 * factor, rect.3 * factor)
}

/// 부모가 bottom-left 좌표계면 DOM top-left y를 뒤집고, flipped면 그대로 둔다.
pub fn top_left_rect_to_parent_frame(
    parent_height: f64,
    parent_flipped: bool,
    rect: (f64, f64, f64, f64),
) -> (f64, f64, f64, f64) {
    let (x, y, w, h) = rect;
    (x, if parent_flipped { y } else { parent_height - y - h }, w, h)
}

/// 이전 rect와 다음 rect 사이에서 위치·크기 축이 각각 변했는지 판정한다.
pub fn rect_delta(
    previous: Option<(f64, f64, f64, f64)>,
    next: (f64, f64, f64, f64),
) -> (bool, bool) {
    match previous {
        None => (true, true),
        Some((px, py, pw, ph)) => (
            (px - next.0).abs() > 0.01 || (py - next.1).abs() > 0.01,
            (pw - next.2).abs() > 0.01 || (ph - next.3).abs() > 0.01,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };
    const RIGHT: Rect = Rect { x: 1920, y: 0, w: 2560, h: 1440 };

    #[test]
    fn a_window_belongs_to_the_monitor_holding_its_center() {
        let w = Rect { x: 100, y: 100, w: 800, h: 600 };
        assert_eq!(monitor_of(w, &[LEFT, RIGHT]), Some(0));
        let w2 = Rect { x: 2000, y: 200, w: 800, h: 600 };
        assert_eq!(monitor_of(w2, &[LEFT, RIGHT]), Some(1));
    }

    /// 경계를 걸친 창도 **하나로** 정해진다 — 넓이로 고르면 픽셀 하나에 소속이 바뀐다.
    #[test]
    fn a_straddling_window_still_gets_one_monitor() {
        // 중심이 1920 보다 왼쪽이면 왼쪽 모니터.
        let w = Rect { x: 1520, y: 0, w: 800, h: 600 };
        assert_eq!(w.center().0, 1920);
        // 중심이 정확히 경계면 오른쪽이다 — 오른쪽 경계는 밖이고 왼쪽 경계는 안이다.
        assert_eq!(monitor_of(w, &[LEFT, RIGHT]), Some(1));
    }

    /// 맞닿은 경계에서 한 점이 양쪽에 속하면 소속이 목록 순서에 따라 흔들린다.
    #[test]
    fn touching_monitors_never_share_a_point() {
        assert!(LEFT.contains(1919, 0));
        assert!(!LEFT.contains(1920, 0));
        assert!(RIGHT.contains(1920, 0));
    }

    /// 화면 밖 창은 없음이다 — 0 으로 떨어뜨리면 "첫 모니터에 있다"와 구분되지 않는다.
    #[test]
    fn a_window_off_every_screen_belongs_to_none() {
        let w = Rect { x: -5000, y: -5000, w: 100, h: 100 };
        assert_eq!(monitor_of(w, &[LEFT, RIGHT]), None);
    }

    #[test]
    fn a_machine_with_no_monitors_answers_none() {
        assert_eq!(monitor_of(Rect { x: 0, y: 0, w: 10, h: 10 }, &[]), None);
    }

    #[test]
    fn one_dom_rect_maps_to_one_parent_frame() {
        assert_eq!(
            top_left_rect_to_parent_frame(600.0, false, (120.0, 50.0, 720.0, 410.0)),
            (120.0, 140.0, 720.0, 410.0),
        );
        assert_eq!(
            top_left_rect_to_parent_frame(600.0, true, (120.0, 50.0, 720.0, 410.0)),
            (120.0, 50.0, 720.0, 410.0),
        );
    }

    #[test]
    fn rect_delta_separates_position_and_size_changes() {
        let previous = Some((100.0, 50.0, 700.0, 400.0));
        assert_eq!(rect_delta(previous, (120.0, 50.0, 700.0, 400.0)), (true, false));
        assert_eq!(rect_delta(previous, (100.0, 50.0, 720.0, 400.0)), (false, true));
        assert_eq!(rect_delta(previous, (120.0, 60.0, 720.0, 410.0)), (true, true));
        assert_eq!(rect_delta(previous, (100.0, 50.0, 700.0, 400.0)), (false, false));
        assert_eq!(rect_delta(None, (1.0, 2.0, 3.0, 4.0)), (true, true));
    }

    #[test]
    fn scaling_changes_every_rect_component() {
        assert_eq!(scale_rect((100.0, 50.0, 300.0, 200.0), 1.2), (120.0, 60.0, 360.0, 240.0));
        assert_eq!(scale_rect((10.0, 20.0, 30.0, 40.0), 1.0), (10.0, 20.0, 30.0, 40.0));
    }

    /// 중심 계산의 나머지 버림 방향까지 같아야 두 프로세스가 같은 답을 낸다.
    #[test]
    fn the_center_is_computed_the_same_way_everywhere() {
        assert_eq!(Rect { x: 0, y: 0, w: 3, h: 3 }.center(), (1, 1));
        assert_eq!(Rect { x: 10, y: 20, w: 5, h: 7 }.center(), (12, 23));
    }

    /// 픽스처가 오라클이다 — 이 파일 하나를 프레임워크 쪽 검사도 읽는다. 한쪽만 고치면
    /// 그쪽이 깨진다(사람 주의력이 아니라 파일이 두 구현을 묶는다).
    #[test]
    fn the_fixture_binds_both_implementations() {
        let raw = include_str!("../fixtures/monitor-of.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("픽스처 JSON");
        let cases = doc["cases"].as_array().expect("cases");
        // 오라클 생존 — 비면 이 검사는 아무것도 안 지키면서 통과한다("0 의 두 얼굴").
        assert!(!cases.is_empty(), "픽스처가 비었다 — 이 검사는 판정할 수 없다");
        for c in cases {
            let r = |v: &serde_json::Value| Rect {
                x: v["x"].as_i64().unwrap() as i32,
                y: v["y"].as_i64().unwrap() as i32,
                w: v["w"].as_i64().unwrap() as i32,
                h: v["h"].as_i64().unwrap() as i32,
            };
            let mons: Vec<Rect> = c["monitors"].as_array().unwrap().iter().map(r).collect();
            let want = c["monitor"].as_u64().map(|n| n as usize);
            assert_eq!(
                monitor_of(r(&c["window"]), &mons),
                want,
                "{}",
                c["why"].as_str().unwrap_or("")
            );
        }
    }
}
