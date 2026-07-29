// 창 표면의 작은 규칙들 — 색과 URL.
//
// 둘 다 "값이 쓸 수 있는가"를 정하는 일이고, 그것은 프레임워크의 것이 아니다. 갈리면 같은
// 값이 한쪽에서만 통과한다: 색은 "테마가 이쪽에서만 안 먹는다"로, URL 은 더 나쁘게 —
// **한쪽만 막던 스킬을 다른 쪽이 연다**로 나타난다.

/// 배경색 하나 — 불투명 RGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// `#rrggbb` 또는 `rrggbb` 를 색으로. 아니면 None.
///
/// 여섯 자리 16진수만 받는다. 세 자리 축약(`#fff`)은 **받지 않는다**: 한쪽이 그것을 펼치고
/// 다른 쪽이 거부하면 같은 테마가 프레임워크마다 다르게 보인다. 늘리려면 양쪽을 함께 늘린다.
pub fn parse_hex_color(raw: &str) -> Option<Rgb> {
    let hex = raw.trim().strip_prefix('#').unwrap_or(raw.trim());
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let p = |s: &str| u8::from_str_radix(s, 16).ok();
    Some(Rgb { r: p(&hex[0..2])?, g: p(&hex[2..4])?, b: p(&hex[4..6])? })
}

/// 새 창으로 열어도 되는 주소인가.
///
/// `http`·`https` 만이다. `file:`·`data:`·`javascript:` 는 창 하나가 로컬 파일을 읽거나
/// 스크립트를 실행하는 통로가 된다 — 그리고 그 창은 이 앱의 창이라 사용자 눈에는 앱이 한 일이다.
///
/// 스킴 비교는 소문자로 한다: `HTTPS:` 를 한쪽만 통과시키면 그 차이가 곧 우회로다.
pub fn is_openable_url(raw: &str) -> bool {
    let raw = raw.trim();
    let Some((scheme, rest)) = raw.split_once(':') else {
        return false;
    };
    // 주소가 없는 스킴은 열 것이 없다(`http:` 하나만 온 경우).
    if !rest.starts_with("//") || rest.len() <= 2 {
        return false;
    }
    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_six_digit_hex_becomes_a_color() {
        assert_eq!(parse_hex_color("#1a2B3c"), Some(Rgb { r: 0x1a, g: 0x2b, b: 0x3c }));
        assert_eq!(parse_hex_color("1a2b3c"), Some(Rgb { r: 0x1a, g: 0x2b, b: 0x3c }));
        assert_eq!(parse_hex_color("  #000000 "), Some(Rgb { r: 0, g: 0, b: 0 }));
    }

    /// 세 자리 축약은 받지 않는다 — 한쪽만 펼치면 같은 테마가 다르게 보인다.
    #[test]
    fn a_short_hex_is_refused_on_both_sides() {
        assert_eq!(parse_hex_color("#fff"), None);
    }

    #[test]
    fn a_non_hex_is_no_color() {
        for bad in ["", "#", "red", "#12345", "#1234567", "#12345g", "rgb(0,0,0)"] {
            assert_eq!(parse_hex_color(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_http_and_https_can_open_a_window() {
        assert!(is_openable_url("https://example.com/x"));
        assert!(is_openable_url("http://example.com"));
        // 대문자 스킴을 한쪽만 통과시키면 그 차이가 곧 우회로다.
        assert!(is_openable_url("HTTPS://example.com"));
    }

    /// 이 창은 앱의 창이다 — 로컬 파일·스크립트 통로가 되면 사용자 눈에는 앱이 한 일이다.
    #[test]
    fn local_and_script_schemes_are_refused() {
        for bad in [
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "soksak://run?cmd=x",
            "ftp://host/x",
        ] {
            assert!(!is_openable_url(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_scheme_without_an_address_opens_nothing() {
        for bad in ["", "https", "https:", "https://", "not a url"] {
            assert!(!is_openable_url(bad), "{bad:?}");
        }
    }

    /// 픽스처가 오라클이다 — 이 파일 하나를 프레임워크 쪽 검사도 읽는다.
    #[test]
    fn the_fixture_binds_both_implementations() {
        let doc: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/surface-spec.json")).expect("픽스처");
        let colors = doc["color"].as_array().expect("color 사례");
        assert!(!colors.is_empty(), "픽스처가 비었다 — 판정할 수 없다");
        for c in colors {
            let why = c["why"].as_str().unwrap_or("");
            let got = parse_hex_color(c["in"].as_str().unwrap());
            match c["out"].as_object() {
                Some(o) => assert_eq!(
                    got,
                    Some(Rgb {
                        r: o["r"].as_u64().unwrap() as u8,
                        g: o["g"].as_u64().unwrap() as u8,
                        b: o["b"].as_u64().unwrap() as u8,
                    }),
                    "{why}"
                ),
                None => assert_eq!(got, None, "{why}"),
            }
        }
        for c in doc["url"].as_array().expect("url 사례") {
            assert_eq!(
                is_openable_url(c["in"].as_str().unwrap()),
                c["out"].as_bool().unwrap(),
                "{}",
                c["why"].as_str().unwrap_or("")
            );
        }
    }
}
