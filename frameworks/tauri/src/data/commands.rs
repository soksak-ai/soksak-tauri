// app.data 의 Tauri 커맨드 표면. 프론트 app.data.* → invoke → 여기. ns 는 호출 측(api.ts)이
// pluginId 로 주입하고 여기서 재검증한다. 변경 커맨드는 app.emit("data-change") 로 전 창 브로드캐스트
// → 프론트 app.data.watch 가 재질의(멀티윈도우·같은 프로젝트 일관, 폴링 0).

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use soksak_core::kv::validate_ns;
use soksak_store::{backup, now_millis, open as store_open, store};
use soksak_store::write_policy::write_with_retry;

use super::{db_path, DbState};
use crate::secrets::SecretsState;

#[allow(clippy::too_many_arguments)]
fn emit_change(
    app: &AppHandle,
    ns: &str,
    coll: Option<&str>,
    scope: Option<&str>,
    op: &str,
    id: Option<&str>,
) {
    // 허브가 있으면 허브로 — 붙은 호스트 전부가 받아야 같은 홈의 다른 프레임워크가 옛 값을
    // 진실로 알지 않는다(A22 알림 축). 없으면 창 가진 프로세스는 이쪽뿐이라 직접 뿌린다.
    // 두 길을 함께 타지 않는다: 방송은 이쪽에도 돌아온다.
    let fact = soksak_core::data_change::payload(ns, coll, scope, op, id);
    let hub = crate::cored_host::current()
        .is_some_and(|h| h.tell("data_change_notify", &fact).is_ok());
    if !hub {
        let _ = app.emit(soksak_core::data_change::EVENT, fact);
    }
    // 쓰기 사실 = 백업 링의 유일한 트리거(폴링 0) — 게이트(1h mtime)와 회전은 저장소 규칙이
    // 소유하고, 어느 저장소인지는 이 프로세스가 안다. 경로를 못 구하면 백업은 건너뛴다
    // (쓰기는 이미 끝났고, 다음 쓰기가 다시 신호한다).
    if let Ok(db) = db_path() {
        super::ring::on_write(db);
    }
}

/// 저장소 하나를 만지는 유일한 통로.
///
/// 이 프로세스가 주인이 아니면 커넥션이 **없는 것이 정상**이다 — 같은 홈에 이미 주인이 있고,
/// 둘이 각자 열면 쓰기자가 둘이 된다. 그때는 "DB 미초기화"가 아니라 그 사실을 이름으로
/// 말한다: 둘을 한 오류로 뭉치면 둘째 프레임워크의 정상 상태가 결함처럼 보이고, 사람이
/// 없는 결함을 쫓는다.
fn with_conn<T>(
    state: &DbState,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    if super::route() == super::StoreRoute::AskOwner {
        return Err(STORE_OWNED_ELSEWHERE.to_string());
    }
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB 미초기화")?;
    f(conn)
}

/// 위임된 명령이 주인에게 보낼 봉투. 이름과 인자를 그대로 나른다 — 여기서 모양을 바꾸면
/// 같은 이름이 두 프로세스에서 두 모양이 된다.
pub fn delegated_call(method: &str, params: Value) -> (String, Value) {
    (method.to_string(), params)
}

/// 주인의 답을 **그 명령의 타입**으로 되돌린다.
///
/// JSON 그대로 두면 부른 쪽이 다시 조립하고, 그 조립이 앱 경로와 갈리는 순간 같은 이름이
/// 두 모양을 답한다. 모양이 다르면 삼키지 않고 사유를 낸다 — 삼키면 "빈 결과"로 나타난다.
pub fn from_owner<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("주인의 답이 이 명령의 모양이 아니다: {e}"))
}

/// 저장소 한 조작 — 주인이면 자기 커넥션으로, 아니면 주인에게 물어서.
///
/// 이 함수가 29개 명령의 갈림을 한 자리에 모은다. 명령마다 갈래를 적으면 그중 하나가
/// 빠지고, 빠진 하나는 위임 상태에서만 실패해 단독 실행에서는 안 보인다.
pub fn store_op<T: serde::de::DeserializeOwned>(
    state: &DbState,
    method: &str,
    params: Value,
    local: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    if super::route() == super::StoreRoute::AskOwner {
        let (m, p) = delegated_call(method, params);
        return from_owner(crate::cored_host::ask_owner(&m, &p)?);
    }
    with_conn(state, local)
}

/// 커넥션을 **쓰지 않고** 갈아끼우는 조작의 갈림 — 주인이면 스스로, 아니면 주인에게.
///
/// store_op 과 달리 커넥션 잠금을 잡지 않는다. 잡은 채로 넘기면, 잠금 슬롯 자체를 바꿔야 하는
/// 조작(파일 교체)이 같은 잠금을 다시 얻으려다 그 자리에서 멈춘다.
pub fn store_own_op<T: serde::de::DeserializeOwned>(
    method: &str,
    params: Value,
    local: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if super::route() == super::StoreRoute::AskOwner {
        let (m, p) = delegated_call(method, params);
        return from_owner(crate::cored_host::ask_owner(&m, &p)?);
    }
    local()
}

/// 위임된 프로세스가 저장소를 직접 만지려 할 때의 사유.
///
/// 이 문자열이 UI 까지 가는 것은 **아직 배선이 안 끝났다는 뜻**이다. 배선이 끝나면 이 자리는
/// cored 로 넘어가고 이 사유는 안 보인다. 그때까지는 조용히 실패하지 않는 것이 낫다.
pub const STORE_OWNED_ELSEWHERE: &str =
    "이 홈의 저장소는 다른 프로세스가 소유한다 — 이 프로세스는 열지 않는다(cored 로 물어야 한다)";

// ── KV ───────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn data_kv_get(
    ns: String,
    key: String,
    state: State<'_, DbState>,
) -> Result<Option<Value>, String> {
    validate_ns(&ns)?;
    // 조회 자체는 soksak-core 이 한다 — 연결은 KvRows 어댑터로 넘긴다.
    store_op(
        &state,
        "data_kv_get",
        serde_json::json!({ "ns": ns, "key": key }),
        |c| soksak_core::kv::get(&store::ConnKvRows(c), &ns, &key),
    )
}

#[tauri::command]
pub fn data_kv_set(
    app: AppHandle,
    ns: String,
    key: String,
    value: Value,
    state: State<'_, DbState>,
) -> Result<(), String> {
    validate_ns(&ns)?;
    store_op(
        &state,
        "data_kv_set",
        serde_json::json!({ "ns": ns, "key": key, "value": value }),
        |c| store::kv_set(c, &ns, &key, &value),
    )?;
    emit_change(&app, &ns, None, None, soksak_core::data_change::op::KV_SET, Some(key.as_str()));
    Ok(())
}

#[tauri::command]
pub fn data_kv_delete(
    app: AppHandle,
    ns: String,
    key: String,
    state: State<'_, DbState>,
) -> Result<bool, String> {
    validate_ns(&ns)?;
    let removed = store_op(
        &state,
        "data_kv_delete",
        serde_json::json!({ "ns": ns, "key": key }),
        |c| store::kv_delete(c, &ns, &key),
    )?;
    if removed {
        emit_change(&app, &ns, None, None, soksak_core::data_change::op::KV_DELETE, Some(key.as_str()));
    }
    Ok(removed)
}

#[tauri::command]
pub fn data_kv_keys(
    ns: String,
    prefix: Option<String>,
    state: State<'_, DbState>,
) -> Result<Vec<String>, String> {
    validate_ns(&ns)?;
    store_op(
        &state,
        "data_kv_keys",
        serde_json::json!({ "ns": ns, "prefix": prefix }),
        |c| store::kv_keys(c, &ns, prefix.as_deref()))
}

// ── 컬렉션 ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn data_define(
    ns: String,
    coll: String,
    indexes: Vec<String>,
    fts: Vec<String>,
    state: State<'_, DbState>,
) -> Result<(), String> {
    validate_ns(&ns)?;
    store_op(
        &state,
        "data_define",
        serde_json::json!({ "ns": ns, "coll": coll, "indexes": indexes, "fts": fts }),
        |c| store::define(c, &ns, &coll, &indexes, &fts),
    )
}

#[tauri::command]
pub fn data_put(
    app: AppHandle,
    ns: String,
    coll: String,
    scope: Option<String>,
    id: Option<String>,
    doc: Value,
    state: State<'_, DbState>,
) -> Result<String, String> {
    validate_ns(&ns)?;
    let scope_s = scope.unwrap_or_default();
    let new_id = store_op(
        &state,
        "data_put",
        serde_json::json!({ "ns": ns, "coll": coll, "scope": scope_s, "id": id, "doc": doc }),
        |c| write_with_retry(c, || store::put(c, &ns, &coll, &scope_s, id.clone(), &doc)),
    )?;
    emit_change(
        &app,
        &ns,
        Some(coll.as_str()),
        Some(scope_s.as_str()),
        soksak_core::data_change::op::PUT,
        Some(new_id.as_str()),
    );
    Ok(new_id)
}

#[tauri::command]
pub fn data_get(
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<Option<Value>, String> {
    validate_ns(&ns)?;
    // [단계②] 봉인(enc=1) 레코드는 vault 의 개인키 S 로 개봉(unlock 필요). 평문은 resolver 무관.
    let resolver = |key_id: &str| secrets.get_data_key(key_id);
    store_op(
        &state,
        "data_get",
        serde_json::json!({ "ns": ns, "coll": coll, "id": id, "scope": scope }),
        |c| {
        store::get(c, &ns, &coll, &id, scope.as_deref(), Some(&resolver))
    })
}

#[tauri::command]
pub fn data_delete(
    app: AppHandle,
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
    state: State<'_, DbState>,
) -> Result<bool, String> {
    validate_ns(&ns)?;
    let removed = store_op(
        &state,
        "data_delete",
        serde_json::json!({ "ns": ns, "coll": coll, "id": id, "scope": scope }),
        |c| store::delete(c, &ns, &coll, &id, scope.as_deref()),
    )?;
    if removed {
        emit_change(
            &app,
            &ns,
            Some(coll.as_str()),
            scope.as_deref(),
            soksak_core::data_change::op::DELETE,
            Some(id.as_str()),
        );
    }
    Ok(removed)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn data_query(
    ns: String,
    coll: String,
    scope: Option<String>,
    filter: Option<Value>,
    order: Option<String>,
    desc: Option<bool>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<Vec<Value>, String> {
    validate_ns(&ns)?;
    let resolver = |key_id: &str| secrets.get_data_key(key_id);
    store_op(
        &state,
        "data_query",
        serde_json::json!({
            "ns": ns, "coll": coll, "scope": scope, "filter": filter,
            "order": order, "desc": desc, "limit": limit, "offset": offset,
        }),
        |c| {
            store::query(
                c,
                &ns,
                &coll,
                scope.as_deref(),
                filter.as_ref(),
                order.as_deref(),
                desc.unwrap_or(true),
                limit,
                offset,
                Some(&resolver),
            )
        },
    )
}

#[tauri::command]
pub fn data_search(
    ns: String,
    coll: String,
    query: String,
    scope: Option<String>,
    limit: Option<i64>,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<Vec<Value>, String> {
    validate_ns(&ns)?;
    let resolver = |key_id: &str| secrets.get_data_key(key_id);
    store_op(
        &state,
        "data_search",
        serde_json::json!({ "ns": ns, "coll": coll, "query": query, "scope": scope, "limit": limit }),
        |c| {
            store::search(
                c,
                &ns,
                &coll,
                &query,
                scope.as_deref(),
                limit,
                Some(&resolver),
            )
        },
    )
}

#[tauri::command]
pub fn data_count(
    ns: String,
    coll: String,
    scope: Option<String>,
    filter: Option<Value>,
    state: State<'_, DbState>,
) -> Result<i64, String> {
    validate_ns(&ns)?;
    store_op(
        &state,
        "data_count",
        serde_json::json!({ "ns": ns, "coll": coll, "scope": scope, "filter": filter }),
        |c| {
        store::count(c, &ns, &coll, scope.as_deref(), filter.as_ref())
    })
}

// ── retention(R5) — 코어가 노출(R0 command registry). 반환=삭제 수. AI/E2E 가 cleanup 호출 가능. ──

// count FIFO — (ns,coll,scope) 수가 cap 초과 시 oldest(created) 축출.
#[tauri::command]
pub fn data_retention_trim(
    ns: String,
    coll: String,
    scope: String,
    cap: i64,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    store_op(
        &state,
        "data_retention_trim",
        serde_json::json!({ "ns": ns, "coll": coll, "scope": scope, "cap": cap }),
        |c| store::retention_trim(c, &ns, &coll, &scope, cap),
    )
}

// TTL reaper — created < cutoff_ms 삭제(시간축).
#[tauri::command]
pub fn data_retention_reap(
    ns: String,
    coll: String,
    cutoff_ms: i64,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    validate_ns(&ns)?;
    store_op(
        &state,
        "data_retention_reap",
        serde_json::json!({ "ns": ns, "coll": coll, "cutoffMs": cutoff_ms }),
        |c| {
            let n = store::retention_reap_ttl(c, &ns, &coll, cutoff_ms)?;
            // [R5] reaper 가 만든 free 페이지를 bounded 반환(physical reclaim). 정리 실패는 비차단.
            let _ = store::incremental_vacuum(c, 256);
            Ok(n)
        },
    )
}

// ── 암호화(단계② — scope 단위 봉투 키 라이프사이클, R0 command registry) ─────────────


// 봉인 커맨드 — 몸은 soksak_store::encryption 이 진다. 여기 남은 것은 State 를 벗기고
// 커넥션과 열쇠 보관소를 넘기는 번역층뿐이다.

pub use soksak_store::encryption::{EnableResult, EncryptionStatus, RotateResult};

/// 이 프로세스의 열쇠 보관소 — 볼트를 계약 모양으로 보인다.
struct VaultKeys<'a>(&'a SecretsState);

impl soksak_store::encryption::DataKeys for VaultKeys<'_> {
    fn is_unlocked(&self) -> bool {
        self.0.is_unlocked()
    }
    fn put_data_key(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        self.0.put_data_key(key_id, secret)
    }
    fn get_data_key(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        self.0.get_data_key(key_id)
    }
    fn delete_data_key(&self, key_id: &str) -> Result<(), String> {
        self.0.delete_data_key(key_id).map(|_| ())
    }
    fn recover_into_vault(&self, key_id: &str, secret: &[u8; 32]) -> Result<(), String> {
        self.0.recover_into_vault(key_id, secret)
    }
}

#[tauri::command]
pub fn data_encrypt_enable(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<EnableResult, String> {
    with_conn(&state, |c| {
        soksak_store::encryption::data_encrypt_enable(c, &VaultKeys(secrets.inner()), scope)
    })
}

#[tauri::command]
pub fn data_encrypt_recover(
    scope: String,
    recovery_code: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<(), String> {
    with_conn(&state, |c| {
        soksak_store::encryption::data_encrypt_recover(
            c,
            &VaultKeys(secrets.inner()),
            scope,
            recovery_code,
        )
    })
}

#[tauri::command]
pub fn data_encrypt_rotate(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<RotateResult, String> {
    with_conn(&state, |c| {
        soksak_store::encryption::data_encrypt_rotate(c, &VaultKeys(secrets.inner()), scope)
    })
}

#[tauri::command]
pub fn data_encrypt_change_recovery(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<String, String> {
    with_conn(&state, |c| {
        soksak_store::encryption::data_encrypt_change_recovery(
            c,
            &VaultKeys(secrets.inner()),
            scope,
        )
    })
}

#[tauri::command]
pub fn data_encrypt_convert(
    ns: String,
    coll: String,
    scope: String,
    state: State<'_, DbState>,
) -> Result<usize, String> {
    with_conn(&state, |c| {
        soksak_store::encryption::data_encrypt_convert(c, ns, coll, scope)
    })
}

#[tauri::command]
pub fn data_encrypt_status(
    scope: String,
    state: State<'_, DbState>,
    secrets: State<'_, SecretsState>,
) -> Result<EncryptionStatus, String> {
    with_conn(&state, |c| {
        soksak_store::encryption::data_encrypt_status(c, &VaultKeys(secrets.inner()), scope)
    })
}

// ── 백업/복원/이식(코어 커맨드 — data.* 카탈로그 핸들러가 ns="core" 로 호출) ───────────

#[tauri::command]
pub fn data_backup(path: Option<String>, state: State<'_, DbState>) -> Result<String, String> {
    let dest = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => crate::identity::ambient()
            .path("backups")
            .join(format!("soksak-{}.db", now_millis())),
    };
    // 경로를 확정한 뒤 실어 보낸다 — 기본값 계산이 양쪽에 있으면 두 프로세스가 다른 파일에 쓴다.
    let dest_s = dest.to_string_lossy().to_string();
    store_op(
        &state,
        "data_backup",
        serde_json::json!({ "path": dest_s }),
        |c| backup::backup(c, &dest),
    )?;
    Ok(dest_s)
}

// ns 회수 — 그 네임스페이스가 만든 모든 것을 지운다(레코드·kv·컬렉션 정의·FTS·인덱스). 만드는 길이
// 있으면 걷는 길도 있어야 한다: 이 표면이 없어 시험이 남의 저장소에 흔적을 남겼다. 남의 ns 는 안 건드린다.
#[tauri::command]
pub fn data_ns_remove(ns: String, state: State<'_, DbState>) -> Result<serde_json::Value, String> {
    // 삭제는 문법을 따지지 않는다. 만드는 길이 규칙을 어겨 앉힌 ns 를 걷지 못하면 그건 회수가 아니다
    // (실측: 검증 없는 import 가 남긴 ns 를 삭제 표면이 "잘못된 ns" 로 거부했다). 지우는 것은
    // 존재하는 것뿐이므로 문법 검증이 지킬 것이 없다.
    store_op(
        &state,
        "data_ns_remove",
        serde_json::json!({ "ns": ns }),
        |c| {
            let out = store::drop_ns(c, &ns)?;
            Ok(serde_json::json!({
                "ns": ns,
                "collections": out.collections,
                "records": out.records,
                "kv": out.kv,
            }))
        },
    )
}

// 지금 쓸 수 있는가 — 한 줄 써 보고 되돌린다(남기지 않는다). 진단은 전부 읽기라 쓰기 고장을 못 본다
// (integrity.rs write_canary 머리말). 읽기만 성한 저장소를 부작용 없이 확인하는 표면.
#[tauri::command]
pub fn data_canary(state: State<'_, DbState>) -> Result<(), String> {
    store_op(&state, "data_canary", serde_json::json!({}), |c| {
        write_with_retry(c, || soksak_store::integrity::write_canary(c))
    })
}

// 저장소 자기 진단 — 전수 대조(integrity_check). 부팅 게이트(quick_check)는 인덱스↔테이블 대조를
// 하지 않아 인덱스 손상을 통과시킨다(integrity.rs 머리말). 읽기 전용.
// 진단이 끝내지 못하면 그 사유를 문제 목록에 실어 돌려준다 — 오류로 던지면 저장소가 아프다는
// 신호가 "명령 실패"로 읽힌다(integrity.rs findings 머리말).
#[tauri::command]
pub fn data_verify(state: State<'_, DbState>) -> Result<Vec<String>, String> {
    store_op(
        &state,
        "data_verify",
        serde_json::json!({}),
        |c| Ok(soksak_store::integrity::findings(c)))
}

// 저장소 실황 — 앱 안의 SQLite 가 자기 한도·메모리·페이지 상태를 답한다(integrity.rs 머리말).
#[tauri::command]
pub fn data_stats(state: State<'_, DbState>) -> Result<soksak_store::integrity::Stats, String> {
    store_op(&state, "data_stats", serde_json::json!({}), |c| {
        // 이 프로세스가 무엇인지 답에 실린다 — 힙 값의 절반은 저장소가 아니라 답한 쪽의 것이다.
        soksak_store::integrity::stats(c, "app")
    })
}

// 저장소 치유 — 인덱스를 테이블에서 다시 만든다(REINDEX). 행은 만들지도 지우지도 않는다.
// 치유 후 다시 진단해 남은 문제를 그대로 싣는다(나았다고 주장만 하지 않는다).
#[tauri::command]
pub fn data_repair(state: State<'_, DbState>) -> Result<soksak_store::integrity::Repair, String> {
    store_op(&state, "data_repair", serde_json::json!({}), |c| {
        soksak_store::integrity::repair(c)
    })
}

#[tauri::command]
pub fn data_restore(app: AppHandle, path: String, state: State<'_, DbState>) -> Result<(), String> {
    // 파일 교체는 **커넥션을 쥔 프로세스**만 할 수 있다 — 잠금을 놓고, 갈고, 다시 여는 셋이
    // 한 손이어야 한다. 위임된 프로세스가 파일만 갈면 주인은 옛 커넥션으로 사라진 파일을 계속
    // 본다. 그래서 여기서는 조작 자체를 주인에게 넘긴다.
    store_own_op::<()>(
        "data_restore",
        serde_json::json!({ "path": path }),
        || {
            let src = std::path::PathBuf::from(&path);
            backup::validate(&src)?;
            let dbp = db_path()?;
            let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
            *guard = None; // 기존 커넥션 드롭(파일 잠금 해제) 후 스왑
            backup::restore_into(&dbp, &src)?;
            *guard = Some(store_open::open(&dbp)?);
            Ok(())
        },
    )?;
    emit_change(&app, "core", None, None, "restore", None);
    Ok(())
}

#[tauri::command]
pub fn data_export(
    ns: Option<String>,
    coll: Option<String>,
    state: State<'_, DbState>,
) -> Result<String, String> {
    store_op(
        &state,
        "data_export",
        serde_json::json!({ "ns": ns, "coll": coll }),
        |c| backup::export(c, ns.as_deref(), coll.as_deref()),
    )
}

#[tauri::command]
pub fn data_import(
    app: AppHandle,
    jsonl: String,
    state: State<'_, DbState>,
) -> Result<i64, String> {
    let n = store_op(
        &state,
        "data_import",
        serde_json::json!({ "jsonl": jsonl }),
        |c| backup::import(c, &jsonl),
    )?;
    emit_change(&app, "core", None, None, "import", None);
    Ok(n)
}

// ── 개명 데이터 이관(파괴적 플러그인 개명 후폭풍 방어) ────────────────────────
// ns = 호출 pluginId 라, 플러그인 id 개명은 옛 id 의 kv/records/meta_collections 를 새 id
// 에서 불가시하게 만든다 → 기존 사용자의 데이터(예: command_blocks) 전멸. 개명한 플러그인이
// 매니페스트에 이전 id 를 선언(renamedFrom)하면 코어 로더가 활성화 시 이 커맨드를 1회 부른다.
// 코어는 특정 id 를 모른다 — 선언된 from/to 만 옮긴다(C1: 코어에 특정 플러그인 이름 없음).
// 멱등: 새 ns 에 데이터가 있으면 이관하지 않는다(이미 이관됨 또는 새 플러그인 자기 데이터 —
// 이관 후 옛 ns 는 비어 다음 활성화가 source-empty 로 스킵). 옛 ns 가 비었으면 할 일 없음.
// 양쪽 다 데이터가 있으면 안전 병합 불가 → 명시 에러(무음 유실 금지). 세 테이블 원자 이동은
// store 가 소유(단위 테스트 가능). 코어는 선언된 from/to 만 옮긴다(C1: 특정 플러그인 이름 없음).
#[tauri::command]
pub fn data_migrate_ns(
    app: AppHandle,
    from_ns: String,
    to_ns: String,
    state: State<'_, DbState>,
) -> Result<store::NsMigrateOutcome, String> {
    validate_ns(&from_ns)?;
    validate_ns(&to_ns)?;
    if from_ns == to_ns {
        return Ok(store::NsMigrateOutcome {
            migrated: false,
            reason: "same-ns".into(),
        });
    }
    let outcome: store::NsMigrateOutcome = store_op(
        &state,
        "data_migrate_ns",
        serde_json::json!({ "fromNs": from_ns, "toNs": to_ns }),
        |c| store::migrate_ns(c, &from_ns, &to_ns),
    )?;
    if outcome.migrated {
        emit_change(&app, &to_ns, None, None, "ns-migrate", None);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use crate::secrets::{FailingKekSource, SecretsState};
    use rusqlite::Connection;
    use soksak_store::store::init_base;

    // (신규 test7) enable fail-closed — no-secret-service(KEK 취득 불가)면 안전핀 순서(S 를
    // put_data_key 로 먼저 → 성공해야 P 등록)가 자동 성립해 봉인 트리거(active P)가 등록되지 않는다.
    // data_encrypt_enable 은 Tauri State 경계라 커맨드 대신 그 순서를 재현 — 무음 평문·orphan 트리거 0.
    #[test]
    fn enable_fail_closed_without_secret_service() {
        let conn = Connection::open_in_memory().unwrap();
        init_base(&conn).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "soksak-enable-fc-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let secrets = SecretsState::default();
        secrets.set_path(dir.join("secrets.vault"));
        secrets.set_kek_source(Box::new(FailingKekSource));

        let (sk, _pk) = crate::secrets::gen_asym_keypair();
        let key_id = soksak_store::doc::new_key_id();
        // (1) S 를 vault 에 먼저 — KEK 취득 불가 → Err(여기서 중단, register 미도달).
        assert!(
            secrets.put_data_key(&key_id, &sk).is_err(),
            "KEK 없으면 S 저장 실패(loud)"
        );
        // (2) 안전핀 — 위가 Err 라 register_active_key 미도달 → active P 없음(봉인 트리거 0).
        assert!(
            soksak_store::doc::active_key(&conn, "proj-a").unwrap().is_none(),
            "P 미등록 — orphan 봉인 트리거 0"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
