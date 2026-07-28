// 창 생성 규칙 — 이름·자리·포커스를 **정하는 자리**.
//
// 창을 만드는 일은 프레임워크의 것이다(BrowserWindow·WebviewWindow). 하지만 **무엇을 만들지**
// 정하는 규칙은 프레임워크의 것이 아니다: 라벨 모양이 갈리면 두 프레임워크의 복원 manifest 가
// 서로를 못 읽고, rect 판정이 갈리면 같은 복원이 한쪽에서만 자리를 지킨다.
//
// 값만 다룬다 — 창을 만들지도, 살아 있는지 묻지도 않는다. 그 둘은 창을 가진 쪽의 사실이다.

/// 워크스페이스 창 라벨의 모양 — `w-<uuid4>`.
///
/// 불투명하고 **재사용되지 않는다**: 닫힌 창의 라벨이 새 창에 붙으면 그 창이 옛 창의 복원
/// 상태를 물려받는다(유령 복원). 의도적 재사용은 리스폰뿐이고, 그때는 라벨이 주어진다.
pub const WORKSPACE_PREFIX: &str = "w-";

/// 창 자리 — 물리 px(window_place·window_monitors 와 같은 좌표계).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 주어진 rect 가 쓸 수 있는 자리인가.
///
/// 넷이 다 있고 다 수라야 한다. 하나라도 빠지면 **자리 없음**이다 — 반쪽을 채워 만들면 창이
/// 엉뚱한 곳에 뜨고, 그 어긋남은 오류가 아니라 "복원했더니 자리가 틀렸다"로 나타난다.
///
/// 크기 0 이하도 자리가 아니다: 만들어지긴 하는데 보이지 않아 "창이 안 뜬다"로만 보인다.
pub fn rect_of(x: Option<f64>, y: Option<f64>, w: Option<f64>, h: Option<f64>) -> Option<Rect> {
    let (x, y, w, h) = (x?, y?, w?, h?);
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return None;
    }
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    Some(Rect { x, y, w, h })
}

/// 이 라벨이 워크스페이스 창의 것인가 — 컨트롤 플레인("main")과 가르는 표식.
pub fn is_workspace(label: &str) -> bool {
    label.starts_with(WORKSPACE_PREFIX)
}

/// 새 창을 앞으로 낼 것인가. 기본은 **참**이다 — 사용자가 새 창을 열면 그 창이 포커스된다.
///
/// 리스폰(재시작 복원)만 거짓으로 부른다: 백그라운드로 되살리고 사용자가 보던 것을 뺏지 않는다.
/// 기본을 거짓으로 두면 "새 창을 열었는데 아무 일도 안 일어난 것처럼" 보인다.
pub fn should_focus(requested: Option<bool>) -> bool {
    requested.unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_rect_is_usable() {
        assert_eq!(
            rect_of(Some(10.0), Some(20.0), Some(800.0), Some(600.0)),
            Some(Rect { x: 10.0, y: 20.0, w: 800.0, h: 600.0 })
        );
    }

    /// 하나라도 빠지면 자리 없음 — 반쪽을 채워 만들면 창이 엉뚱한 곳에 뜬다.
    #[test]
    fn a_partial_rect_is_no_rect() {
        assert_eq!(rect_of(None, Some(0.0), Some(1.0), Some(1.0)), None);
        assert_eq!(rect_of(Some(0.0), None, Some(1.0), Some(1.0)), None);
        assert_eq!(rect_of(Some(0.0), Some(0.0), None, Some(1.0)), None);
        assert_eq!(rect_of(Some(0.0), Some(0.0), Some(1.0), None), None);
    }

    /// 크기 0 이하는 만들어지긴 하는데 보이지 않는다 — "창이 안 뜬다"로만 보인다.
    #[test]
    fn a_zero_sized_rect_is_no_rect() {
        assert_eq!(rect_of(Some(0.0), Some(0.0), Some(0.0), Some(600.0)), None);
        assert_eq!(rect_of(Some(0.0), Some(0.0), Some(800.0), Some(-1.0)), None);
    }

    #[test]
    fn a_nonfinite_rect_is_no_rect() {
        assert_eq!(rect_of(Some(f64::NAN), Some(0.0), Some(1.0), Some(1.0)), None);
        assert_eq!(rect_of(Some(0.0), Some(f64::INFINITY), Some(1.0), Some(1.0)), None);
    }

    #[test]
    fn a_workspace_label_is_told_by_its_prefix() {
        assert!(is_workspace("w-2f1c"));
        assert!(!is_workspace("main"));
        assert!(!is_workspace(""));
    }

    /// 기본을 거짓으로 두면 "새 창을 열었는데 아무 일도 안 일어난 것처럼" 보인다.
    #[test]
    fn focus_defaults_to_true() {
        assert!(should_focus(None));
        assert!(should_focus(Some(true)));
        assert!(!should_focus(Some(false)));
    }

    /// 픽스처가 오라클이다 — 이 파일 하나를 프레임워크 쪽 검사도 읽는다. 한쪽만 고치면 그쪽이
    /// 깨진다(사람 주의력이 아니라 파일이 두 구현을 묶는다).
    #[test]
    fn the_fixture_binds_both_implementations() {
        let raw = include_str!("../fixtures/window-rect.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("픽스처 JSON");
        let num = |v: &serde_json::Value, k: &str| v.get(k).and_then(|n| n.as_f64());

        let rects = doc["rect"].as_array().expect("rect 사례");
        assert!(!rects.is_empty(), "픽스처가 비었다 — 판정할 수 없다");
        for c in rects {
            let why = c["why"].as_str().unwrap_or("");
            let i = &c["in"];
            let got = rect_of(num(i, "x"), num(i, "y"), num(i, "w"), num(i, "h"));
            match c["out"].as_object() {
                Some(o) => {
                    let want = Rect {
                        x: o["x"].as_f64().unwrap(),
                        y: o["y"].as_f64().unwrap(),
                        w: o["w"].as_f64().unwrap(),
                        h: o["h"].as_f64().unwrap(),
                    };
                    assert_eq!(got, Some(want), "{why}");
                }
                None => assert_eq!(got, None, "{why}"),
            }
        }

        for c in doc["focus"].as_array().expect("focus 사례") {
            assert_eq!(
                should_focus(c["in"].as_bool()),
                c["out"].as_bool().unwrap(),
                "{}",
                c["why"].as_str().unwrap_or("")
            );
        }

        for c in doc["workspaceLabel"].as_array().expect("label 사례") {
            assert_eq!(
                is_workspace(c["in"].as_str().unwrap()),
                c["out"].as_bool().unwrap(),
                "{}",
                c["why"].as_str().unwrap_or("")
            );
        }
    }
}
