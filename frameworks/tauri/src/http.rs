// HTTP capability 의 이 프레임워크 자리 — 몸은 soksak-net 이 진다.
//
// 여기 남는 것은 볼트를 **인자로 올리는** 한 걸음과 `#[tauri::command]` 래퍼뿐이다. 볼트를 연
// 것은 이 프로세스이고(키체인 신원·잠금 수명이 여기 있다), 규칙은 "ns 와 key 로 평문 하나"라는
// 함수만 받는다. 규칙이 볼트를 앰비언트로 캐면 같은 코드가 프로세스마다 다른 시크릿을 집는다.

use crate::secrets::{self, SecretsState};
use soksak_net::http::{HttpRequest, HttpResponse};
use std::collections::HashMap;
use tauri::State;

// 열린 볼트를 해소 함수로 묶어 규칙에 넘긴다. 명령 래퍼와 검사가 같은 자리를 지나게 두어,
// 배선이 어긋나면 검사가 먼저 깨진다(래퍼만 있으면 그 배선은 아무도 안 본다).
pub fn request_with(state: &SecretsState, req: HttpRequest) -> Result<HttpResponse, String> {
    soksak_net::http::request(&|ns, key| secrets::resolve(state, ns, key), req)
}

// 시크릿은 ns 볼트에서만 해소한다 — ns 는 app.network.http 가 manifest.id 로 주입(타 ns 시크릿
// 탈취 차단). CLI/E2E 는 명시 ns(운영자 신뢰).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn net_http_request(
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    query: Option<HashMap<String, String>>,
    body: Option<String>,
    content_type: Option<String>,
    ns: Option<String>,
    secret_subst: Option<HashMap<String, String>>,
    impersonate: Option<String>,
    secrets_state: State<'_, SecretsState>,
) -> Result<HttpResponse, String> {
    request_with(
        &secrets_state,
        HttpRequest {
            method,
            url,
            headers: headers.unwrap_or_default(),
            query: query.unwrap_or_default(),
            body,
            content_type,
            ns,
            secret_subst,
            impersonate,
        },
    )
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
