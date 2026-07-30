//! 저장소 명령의 몸 — 표는 registry_table.rs 가, 규칙은 soksak-store 가 진다.
//!
//! 여기 있는 것은 배선뿐이다: 인자를 읽고, 쓰기 소유권을 확인하고, 커넥션을 열어 규칙에 넘긴다.
//! 규칙을 여기에 적으면 앱 경로와 이 경로가 같은 이름에 다른 답을 내고, 그 차이는 오류가
//! 아니라 잃어버린 데이터나 없는 백업으로 나타난다.

use serde_json::Value;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome, SqliteRows};


#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvGetArg {
    ns: String,
    key: String,
}

pub(crate) fn run_data_kv_get(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvGetArg| {
        // 읽기는 잠그지 않는다 — WAL 은 읽기 동시·쓰기 단일이고, 쓰기 소유권이 없어도
        // 관측은 되어야 한다(못 쓰는 것과 못 보는 것은 다른 사실이다).
        let conn = rusqlite::Connection::open_with_flags(
            ctx.db_path(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("저장소 열기 실패: {e}"))?;
        let rows = SqliteRows { conn };
        soksak_core::kv::get(&rows, &a.ns, &a.key)
    })
}

impl soksak_core::kv::KvWrite for SqliteRows {
    fn put(&self, ns: &str, key: &str, raw: &str, updated_ms: u64) -> Result<(), String> {
        self.conn
            .execute(soksak_core::kv::UPSERT_SQL, (ns, key, raw, updated_ms as i64))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

impl soksak_core::kv::KvDelete for SqliteRows {
    fn remove(&self, ns: &str, key: &str) -> Result<bool, String> {
        self.conn
            .execute(soksak_core::kv::DELETE_SQL, (ns, key))
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }
}



#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvSetArg {
    ns: String,
    key: String,
    value: Value,
}

// ── 저장소 표면의 배선 ────────────────────────────────────────────────────────
//
// 판정은 하나도 여기 없다 — 전부 soksak-store 를 부른다. 여기서 한 줄이라도 판정하면 앱 경로와
// 이 경로가 다르게 답할 수 있고, 그 차이는 오류가 아니라 **다른 데이터**로 나타난다.
//
// 쓰기는 소유권을 **열기 전에** 본다. 열고 나서 판단하면 그 사이가 곧 이중 쓰기 창이다.

fn deny_without_write_ownership(ctx: &Ctx) -> Result<(), String> {
    if ctx.owns_writes() {
        return Ok(());
    }
    Err(format!(
        "이 저장소의 쓰기는 다른 프로세스가 소유한다({}) — 같은 홈에 앱이나 다른 cored 가 \
         살아 있다. 읽기는 계속 서빙한다",
        ctx.db_path().display()
    ))
}

#[derive(serde::Deserialize)]
struct NsArg {
    ns: String,
}

pub(crate) fn run_data_ns_remove(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: NsArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        let r = soksak_store::store::drop_ns(&conn, &a.ns)?;
        serde_json::to_value(r).map_err(|e| e.to_string())
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportArg {
    ns: Option<String>,
    coll: Option<String>,
}

pub(crate) fn run_data_export(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ExportArg| {
        let conn = ctx.open_db()?;
        soksak_store::backup::export(&conn, a.ns.as_deref(), a.coll.as_deref()).map(Value::String)
    })
}

#[derive(serde::Deserialize)]
struct ImportArg {
    jsonl: String,
}

pub(crate) fn run_data_import(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ImportArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::backup::import(&conn, &a.jsonl).map(Value::from)
    })
}

#[derive(serde::Deserialize)]
struct BackupArg {
    path: Option<String>,
}

pub(crate) fn run_data_backup(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: BackupArg| {
        // 백업은 읽기지만 VACUUM INTO 라 저장소를 통째로 훑는다. 소유권을 안 보는 대신
        // **대상 경로는 호출자가 준다** — 여기서 기본 자리를 지어내면 앱이 쓰는 자리와
        // 갈리고, 그 차이는 "백업이 어디 갔지"로 나타난다.
        let dest = a
            .path
            .ok_or_else(|| "백업 대상 경로가 없다 — 이 프로세스는 자리를 지어내지 않는다".to_string())?;
        let conn = ctx.open_db()?;
        soksak_store::backup::backup(&conn, std::path::Path::new(&dest))?;
        Ok(Value::String(dest))
    })
}

#[derive(serde::Deserialize)]
struct RestorePathArg {
    path: String,
}

pub(crate) fn run_data_restore(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: RestorePathArg| {
        deny_without_write_ownership(ctx)?;
        let src = std::path::PathBuf::from(&a.path);
        // 검증이 먼저다 — 못 쓸 파일로 덮어쓰면 되돌릴 것이 없다.
        soksak_store::backup::validate(&src)?;
        soksak_store::backup::restore_into(&ctx.db_path(), &src)?;
        Ok(Value::Null)
    })
}

pub(crate) fn run_data_verify(ctx: &Ctx, _params: &Value) -> Outcome {
    match ctx.open_db().and_then(|c| soksak_store::integrity::check(&c)) {
        Ok(v) => Outcome::Ok(Value::Array(v.into_iter().map(Value::String).collect())),
        Err(e) => Outcome::Failed(e),
    }
}

pub(crate) fn run_data_repair(ctx: &Ctx, _params: &Value) -> Outcome {
    match ctx
        .open_db()
        .and_then(|c| soksak_store::integrity::repair(&c))
        .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
    {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Failed(e),
    }
}

pub(crate) fn run_data_canary(ctx: &Ctx, _params: &Value) -> Outcome {
    if let Err(e) = deny_without_write_ownership(ctx) {
        return Outcome::Failed(e);
    }
    // 앱 경로와 같은 쓰기 정책 — 카나리아가 정책 밖에서 돌면 "지금 쓸 수 있는가"를 실제 쓰기와
    // 다른 조건으로 답한다(견디는 쓰기는 되는데 카나리아만 실패한다).
    match ctx.open_db().and_then(|c| {
        soksak_store::write_policy::write_with_retry(&c, || {
            soksak_store::integrity::write_canary(&c)
        })
    }) {
        Ok(()) => Outcome::Ok(Value::Null),
        Err(e) => Outcome::Failed(e),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReapArg {
    ns: String,
    coll: String,
    cutoff_ms: i64,
}

pub(crate) fn run_data_retention_reap(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ReapArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::retention_reap_ttl(&conn, &a.ns, &a.coll, a.cutoff_ms)
            .map(|n| Value::from(n as u64))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrimArg {
    ns: String,
    coll: String,
    scope: String,
    cap: i64,
}

pub(crate) fn run_data_retention_trim(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: TrimArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::retention_trim(&conn, &a.ns, &a.coll, &a.scope, a.cap)
            .map(|n| Value::from(n as u64))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertArg {
    ns: String,
    coll: String,
    scope: String,
}

pub(crate) fn run_data_encrypt_convert(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ConvertArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        // batch 상한은 앱과 같은 값을 쓴다 — 다르면 같은 이름이 프로세스마다 다른 양을 옮긴다.
        soksak_store::store::convert_pending(&conn, &a.ns, &a.coll, &a.scope, ENCRYPT_CONVERT_BATCH)
            .map(|n| Value::from(n as u64))
    })
}

/// 한 번에 변환하는 레코드 수 — 앱의 data_encrypt_convert 와 같은 값이라야 한다.
const ENCRYPT_CONVERT_BATCH: i64 = 200;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutArg {
    ns: String,
    coll: String,
    scope: Option<String>,
    id: Option<String>,
    doc: Value,
}

pub(crate) fn run_data_put(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: PutArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        // 앱 경로와 같은 쓰기 정책을 탄다 — 정책이 한쪽에만 있으면 같은 이름이 어느 프로세스가
        // 답하느냐에 따라 다르게 쓴다: 한쪽은 압박을 견디고 다른 쪽은 첫 실패에 사용자의 저장을
        // 버린다. 그 차이는 오류가 아니라 잃어버린 데이터로 나타난다.
        let id = soksak_store::write_policy::write_with_retry(&conn, || {
            soksak_store::store::put(
                &conn,
                &a.ns,
                &a.coll,
                a.scope.as_deref().unwrap_or(""),
                a.id.clone(),
                &a.doc,
            )
        })?;
        // 쓰기 사실 = 백업 링의 유일한 트리거(폴링 0). 앱 경로만 걸면 이 프로세스가 서빙하는
        // 쓰기는 링을 한 번도 안 돌리고, 그 차이는 오류가 아니라 **없는 백업**으로 나타난다.
        crate::backup_ring::on_write(ctx);
        Ok(Value::String(id))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetArg {
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
}

pub(crate) fn run_data_get(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: GetArg| {
        // 읽기는 소유권을 안 본다 — 못 쓰는 것과 못 보는 것은 다른 사실이다(WAL 은 읽기 동시).
        let conn = ctx.open_db()?;
        // 복호 해석자는 `None` 이다 — 이 프로세스는 볼트를 열지 않는다. 봉인된 레코드는
        // 봉인된 채로 답한다. 그것을 여는 것은 볼트를 가진 쪽의 일이고, 여기서 흉내내면
        // 열쇠 없이 연 척하는 답이 나간다.
        soksak_store::store::get(
            &conn,
            &a.ns,
            &a.coll,
            &a.id,
            a.scope.as_deref(),
            None,
        )
        .map(|v| v.unwrap_or(Value::Null))
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteArg {
    ns: String,
    coll: String,
    id: String,
    scope: Option<String>,
}

pub(crate) fn run_data_delete(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: DeleteArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::delete(&conn, &a.ns, &a.coll, &a.id, a.scope.as_deref())
            .map(Value::Bool)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountArg {
    ns: String,
    coll: String,
    scope: Option<String>,
    filter: Option<Value>,
}

pub(crate) fn run_data_count(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: CountArg| {
        let conn = ctx.open_db()?;
        soksak_store::store::count(&conn, &a.ns, &a.coll, a.scope.as_deref(), a.filter.as_ref())
            .map(Value::from)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArg {
    ns: String,
    coll: String,
    query: String,
    scope: Option<String>,
    limit: Option<i64>,
}

pub(crate) fn run_data_search(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: SearchArg| {
        let conn = ctx.open_db()?;
        // get 과 같은 이유로 해석자는 None 이다.
        soksak_store::store::search(
            &conn,
            &a.ns,
            &a.coll,
            &a.query,
            a.scope.as_deref(),
            a.limit,
            None,
        )
        .map(Value::Array)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvDeleteArg {
    ns: String,
    key: String,
}

pub(crate) fn run_data_kv_delete(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvDeleteArg| {
        deny_without_write_ownership(ctx)?;
        let conn = ctx.open_db()?;
        soksak_store::store::kv_delete(&conn, &a.ns, &a.key)?;
        Ok(Value::Null)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KvKeysArg {
    ns: String,
    prefix: Option<String>,
}

pub(crate) fn run_data_kv_keys(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvKeysArg| {
        let conn = ctx.open_db()?;
        soksak_store::store::kv_keys(&conn, &a.ns, a.prefix.as_deref())
            .map(|ks| Value::Array(ks.into_iter().map(Value::String).collect()))
    })
}

pub(crate) fn run_data_kv_set(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: KvSetArg| {
        // 소유권 먼저 — 열기 전에 거절한다. 열고 나서 판단하면 그 사이가 곧 이중 쓰기 창이다.
        if !ctx.owns_writes() {
            return Err(format!(
                "이 저장소의 쓰기는 다른 프로세스가 소유한다({}) — 같은 홈에 앱이나 다른                  cored 가 살아 있다. 읽기는 계속 서빙한다",
                ctx.db_path().display()
            ));
        }
        let conn = ctx.open_db()?;
        let store = SqliteRows { conn };
        soksak_core::kv::set(&store, &a.ns, &a.key, &a.value, crate::ledger::now_ms())?;
        // 앱의 data_kv_set 은 () 를 돌려준다 — 같은 모양이라야 프레임워크가 값을 다시 조립하지 않는다.
        Ok(Value::Null)
    })
}
