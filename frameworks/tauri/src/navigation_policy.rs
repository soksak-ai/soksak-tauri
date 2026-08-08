//! Native navigation policy for every webview owned by the application.
//!
//! Tests are intentionally written before the implementation.  The app shell
//! hosts opaque-origin plugin frames, so an external navigation from `main` or
//! `w-*` must be denied by the native webview layer.  Browser surfaces are a
//! separate role and may navigate only to their explicit public schemes.

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime, Url};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigationBlocked {
    webview_label: String,
    target_origin: String,
}

fn is_workspace_label(label: &str) -> bool {
    label == "main"
        || label
            .strip_prefix("w-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

fn is_browser_surface(label: &str) -> bool {
    label.starts_with("b-")
        || label
            .strip_prefix("popup-")
            .is_some_and(|seq| !seq.is_empty() && seq.bytes().all(|byte| byte.is_ascii_digit()))
        || label
            .strip_prefix("media-extract-")
            .is_some_and(|seq| !seq.is_empty() && seq.bytes().all(|byte| byte.is_ascii_digit()))
}

fn is_plugin_view_renderer(label: &str) -> bool {
    label.strip_prefix("pv-").is_some_and(|identity| !identity.is_empty())
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_application_asset(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"))
}

fn is_empty_document(url: &Url) -> bool {
    url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc")
}

/// Pure policy used by the global Tauri navigation hook and its tests.
///
/// The containing webview label is the native principal.  An iframe payload is
/// never allowed to select a different role.  App shells may load only bundled
/// assets, their exact configured dev origin, and the browser-created empty
/// documents needed for sandbox bootstrap.  Browser surfaces intentionally
/// support normal web-document schemes but never local/Tauri/IPC schemes.
pub(crate) fn navigation_allowed(webview_label: &str, target: &Url, dev_url: Option<&Url>) -> bool {
    if is_workspace_label(webview_label) {
        return is_application_asset(target)
            || is_empty_document(target)
            || dev_url.is_some_and(|origin| same_origin(origin, target));
    }
    if is_browser_surface(webview_label) {
        return matches!(
            target.scheme(),
            "http" | "https" | "about" | "data" | "blob"
        );
    }
    if is_plugin_view_renderer(webview_label) {
        return is_application_asset(target)
            || is_empty_document(target)
            || target.scheme() == "blob"
            || dev_url.is_some_and(|origin| same_origin(origin, target));
    }
    false
}

fn target_origin(target: &Url) -> String {
    match target.host_str() {
        Some(host) => match target.port() {
            Some(port) => format!("{}://{host}:{port}", target.scheme()),
            None => format!("{}://{host}", target.scheme()),
        },
        None => format!("{}:<opaque>", target.scheme()),
    }
}

/// Installs one native navigation policy for every present and future webview,
/// including the configured initial window.  Per-browser handlers still run
/// first; both policies must allow a navigation for it to proceed.
pub(crate) fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("soksak-navigation-policy")
        .on_navigation(|webview, target| {
            let dev_url = webview.app_handle().config().build.dev_url.as_ref();
            let allowed = navigation_allowed(webview.label(), target, dev_url);
            if !allowed {
                let blocked = NavigationBlocked {
                    webview_label: webview.label().to_string(),
                    // Do not leak an attempted exfiltration payload into logs/events.
                    target_origin: target_origin(target),
                };
                eprintln!(
                    "[navigation-policy] blocked webview={} target={}",
                    blocked.webview_label, blocked.target_origin
                );
                let _ = webview.emit("navigation-blocked", blocked);
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Url;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test URL")
    }

    #[test]
    fn application_shell_denies_external_and_privileged_navigation() {
        for label in ["main", "w-2c22da8b-b873-4c4b-9ee2-a3ff6fb81c04"] {
            assert!(navigation_allowed(
                label,
                &url("tauri://localhost/index.html"),
                None
            ));
            assert!(navigation_allowed(label, &url("about:blank"), None));
            assert!(navigation_allowed(label, &url("about:srcdoc"), None));

            for denied in [
                "https://attacker.example/exfiltrate",
                "http://127.0.0.1:8080/private",
                "file:///private/etc/passwd",
                "data:text/html,owned",
                "javascript:alert(1)",
                "ipc://localhost/secret_keys",
            ] {
                assert!(
                    !navigation_allowed(label, &url(denied), None),
                    "app shell accepted {denied}",
                );
            }
        }
    }

    #[test]
    fn application_shell_allows_only_the_declared_dev_origin() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        assert!(navigation_allowed(
            "main",
            &url("http://localhost:1420/index.html?window=main"),
            Some(&dev),
        ));
        assert!(!navigation_allowed(
            "main",
            &url("http://localhost:1421/index.html"),
            Some(&dev),
        ));
        assert!(!navigation_allowed(
            "main",
            &url("http://127.0.0.1:1420/index.html"),
            Some(&dev),
        ));
    }

    #[test]
    fn plugin_view_renderer_loads_only_app_assets_and_blob_modules() {
        let label = "pv-w-2c22da8b-b873-4c4b-9ee2-a3ff6fb81c04-1";
        assert!(navigation_allowed(label, &url("tauri://localhost/plugin-view.html"), None));
        assert!(navigation_allowed(label, &url("blob:tauri://localhost/renderer"), None));
        for denied in [
            "https://attacker.example/exfiltrate",
            "file:///private/etc/passwd",
            "ipc://localhost/secret_keys",
        ] {
            assert!(!navigation_allowed(label, &url(denied), None));
        }
    }

    #[test]
    fn browser_surfaces_have_a_distinct_scheme_allowlist() {
        for label in ["b-main-view-1", "popup-3", "media-extract-4"] {
            assert!(navigation_allowed(
                label,
                &url("https://example.com/path"),
                None
            ));
            assert!(navigation_allowed(
                label,
                &url("http://example.com/path"),
                None
            ));
            assert!(navigation_allowed(label, &url("about:blank"), None));
            assert!(navigation_allowed(
                label,
                &url("data:text/html,document"),
                None
            ));
            assert!(navigation_allowed(
                label,
                &url("blob:https://example.com/843b0c6d-2a71-4e10-89e3-e33dca4dfc8c"),
                None,
            ));
            for denied in [
                "file:///private/etc/passwd",
                "javascript:alert(1)",
                "ipc://localhost/secret_keys",
                "tauri://localhost/index.html",
            ] {
                assert!(
                    !navigation_allowed(label, &url(denied), None),
                    "browser surface accepted {denied}",
                );
            }
        }
    }

    #[test]
    fn unknown_webview_roles_default_deny() {
        assert!(!navigation_allowed(
            "third-party-surface",
            &url("https://example.com"),
            None,
        ));
        assert!(!navigation_allowed(
            "third-party-surface",
            &url("tauri://localhost/index.html"),
            None,
        ));
    }

    #[test]
    fn tauri_config_enables_csp_and_exposes_no_filesystem_asset_scope() {
        let raw = std::fs::read_to_string("tauri.conf.json").expect("tauri config");
        let config: serde_json::Value = serde_json::from_str(&raw).expect("valid tauri config");
        let security = &config["app"]["security"];

        let csp = security["csp"].as_str().expect("CSP must be enabled");
        for directive in [
            "default-src 'self'",
            "ipc: asset: http://asset.localhost http://ipc.localhost",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ] {
            assert!(csp.contains(directive), "CSP missing `{directive}`: {csp}");
        }

        // 자원 프로토콜은 **켠다.** 플러그인 번들이 IPC 를 지나면 그 양이 곧 부팅 시간이다
        // (실측 2026-08-08: 23.8MB 중 약 15MB 가 문자열로 건너느라 818ms, 엔진 자원 경로로는
        // 41ms). 그래서 규칙이 "끈다" 에서 **"좁힌다"** 로 바뀐다 — 여는 이유가 생겼으니
        // 지켜야 할 것은 넓이다.
        assert_eq!(
            security["assetProtocol"]["enable"],
            serde_json::Value::Bool(true),
            "plugin bundles load through the asset protocol; disabling it puts 15MB back on IPC",
        );
        let allow = security["assetProtocol"]["scope"]["allow"]
            .as_array()
            .expect("enabled asset protocol must declare what it opens");
        assert!(!allow.is_empty(), "asset scope must name what it opens");
        for pattern in allow {
            let pattern = pattern.as_str().expect("scope entries are patterns");
            // 홈 전체를 열면 웹뷰가 사용자의 모든 파일을 읽는다 — 번들을 읽으려고 연 문이
            // 문서·열쇠까지 함께 연다.
            assert!(
                pattern.contains("/plugins/"),
                "asset scope must stay inside plugin directories: {pattern}",
            );
            assert!(
                !pattern.starts_with("$HOME/**") && !pattern.starts_with("/**"),
                "asset scope must not open a whole tree: {pattern}",
            );
        }
        // freezePrototype 는 꺼둔다. 플러그인은 full-trust 로 이 창의 realm 에 직접 적재되고(창-realm
        // 실행), 동결된 Object.prototype 은 상속 속성에 쓰는 표준 라이브러리를 깬다 — xterm.js 의
        // TS-namespace 산물이 `o.toString = fn` 을 빈 객체에 하는데, 동결 시 상속 toString 이 readonly 라
        // strict-mode ESM 에서 throw(터미널 활성 사망). CSP 가 script-src 를 'self' blob: 로 막아 외부
        // 주입 경로가 없으므로 이 하드닝의 marginal 가치는 낮다. realm 별 하드닝은 플러그인 격리(v2)에서
        // 복원한다 — 그때 앱 realm 은 다시 동결하되 플러그인은 제 realm 에서 돈다.
        assert_eq!(security["freezePrototype"], serde_json::Value::Bool(false));

        let cargo = std::fs::read_to_string("Cargo.toml").expect("Cargo manifest");
        assert!(
            cargo.contains("protocol-asset"),
            "the asset protocol the config enables must actually be compiled in",
        );
    }
}
