// UDP capability 의 프레임워크 진입점 — 로직은 soksak-core 에 있다.
//
// 여기 남은 것은 `#[tauri::command]` 속성뿐이다. 그 속성 자체가 tauri 의존이라
// 코어 크레이트가 가질 수 없다 — 그래서 프레임워크 쪽에 무논리 위임 래퍼만 둔다.
// 래퍼에 판단을 넣지 마라: 판단이 여기 있으면 cored 프로세스에서는 그 판단이 사라진다.

pub use soksak_core::udp::UdpPacket;

#[tauri::command]
pub fn net_udp_send(
    host: String,
    port: u16,
    data: Vec<u8>,
    broadcast: Option<bool>,
) -> Result<usize, String> {
    soksak_core::udp::net_udp_send(host, port, data, broadcast)
}

#[tauri::command]
pub fn net_udp_request(
    host: String,
    port: u16,
    data: Vec<u8>,
    timeout_ms: Option<u64>,
    max_packets: Option<usize>,
) -> Result<Vec<UdpPacket>, String> {
    soksak_core::udp::net_udp_request(host, port, data, timeout_ms, max_packets)
}
