// 미디어 프록시의 이 프레임워크 자리 — 몸은 soksak-net 이 진다.
//
// 여기 남는 것은 둘뿐이다. ① 이 프로세스가 세운 프록시 손잡이를 어디에 둘지(앱 상태) —
// 포트·토큰은 기동한 프로세스의 것이라 규칙이 들 수 없다. ② `#[tauri::command]` 래퍼.

use soksak_net::mediaproxy::MediaProxy;
use tauri::State;

// 이 프로세스의 프록시 손잡이. 기동 실패해도 앱은 산다(재생만 실패) — 그때 값은 None 이고
// media_proxy_info 가 "미기동"으로 정직히 실패한다. 없는 base 를 짐작해 조립하면 아무도 안
// 듣는 주소가 나가고, 플러그인은 그 URL 로 만든 재생만 조용히 실패한다.
pub struct MediaProxyHandle(pub Option<MediaProxy>);

#[derive(serde::Serialize, Debug)]
pub struct MediaProxyInfo {
    pub base: String,
    pub port: u16,
    pub token: String,
}

// 플러그인은 이 base 로 프록시 URL 을 자체 조립한다: {base}/m3u8?url=&referer=&ua= / {base}/stream?...
#[tauri::command]
pub fn media_proxy_info(state: State<'_, MediaProxyHandle>) -> Result<MediaProxyInfo, String> {
    let proxy = state.0.as_ref().ok_or("media proxy 미기동")?;
    Ok(MediaProxyInfo {
        base: proxy.base(),
        port: proxy.port(),
        token: proxy.token().to_string(),
    })
}
