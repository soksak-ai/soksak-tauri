// 쓰기 잠금이 **무엇을 지키고 무엇을 안 지키는지**를 값으로 못 박는다.
//
// 문서는 오래 "잠금을 못 잡으면 읽기만 서빙하고 쓰기는 이름을 달고 거절한다"고 적었다.
// 그 문장은 `data_kv_set` 에 대해서만 참이다. `activity_publish` 는 원장 행을 `records` 에
// 남기는데(ledger::persist), 그 경로는 `owns_writes()` 를 보지 않는다.
//
// 이 차이는 우연이 아니라 선택이다. 적재만 하고 남기지 않던 시절의 실측(2026-07-28,
// Electron 라이브)은 **publish 24회 성공에 records 0행**이었다 — 답은 전부 성공이었고,
// 부재는 다음 부팅에서 "아무 일도 없었던 것"으로만 드러났다. 그 자리에 잠금 게이트를 달면
// 같은 침묵이 그대로 돌아온다.
//
// 그래서 이 검사는 두 사실을 함께 잰다: 잠금이 지키는 쓰기(kv)는 이름을 달고 거절되고,
// 잠금 밖의 쓰기(원장)는 실제로 행을 남긴다. 어느 쪽이 움직여도 실패한다 — 문서가 다시
// 거짓이 되는 순간이 곧 이 검사가 빨개지는 순간이다.

#![cfg(unix)]

use rusqlite::Connection;
use serde_json::{json, Value};
use soksak_core::identity::Identity;
use soksak_cored::ctx::Ctx;
use soksak_cored::registry::{self, Outcome};

/// 검사마다 다른 홈. 같은 자리를 쓰면 앞 검사가 잡아 둔 잠금과 남긴 행을 보게 된다.
fn fresh_home() -> std::path::PathBuf {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("soksak-writes-outside-lock-{stamp}-{n}"))
}

fn ctx_at(home: &std::path::Path) -> Ctx {
    Ctx::new(Identity::new(home.to_string_lossy().to_string(), "com.soksak.dev"))
        .with_data_dir(home.join("data"))
}

fn call(ctx: &Ctx, name: &str, params: Value) -> Outcome {
    let cmd = registry::find(name).unwrap_or_else(|| panic!("{name} 이 서빙 표에 없다"));
    (cmd.run)(ctx, &params)
}

fn activity_rows(db: &std::path::Path) -> i64 {
    Connection::open(db)
        .expect("저장소 열기")
        .query_row(
            "SELECT COUNT(*) FROM records WHERE ns='core' AND coll='activity'",
            [],
            |r| r.get(0),
        )
        .expect("원장 행 세기")
}

/// 잠금을 **못 잡은** 프로세스에서 두 쓰기가 서로 다르게 답한다.
#[test]
fn the_lock_guards_the_kv_write_and_not_the_ledger_write() {
    let home = fresh_home();

    // 먼저 잡은 쪽 — 이 홈의 앱 자리다. 저장소 형태도 여기서 선다.
    let mut owner = ctx_at(&home);
    assert!(owner.claim_writes().expect("쓰기 소유권"), "빈 홈은 소유권을 잡는다");
    let db = owner.db_path();

    // 뒤에 붙은 쪽 — 같은 홈의 두 번째 백엔드.
    let mut guest = ctx_at(&home);
    assert!(
        !guest.claim_writes().expect("쓰기 소유권 시도"),
        "이미 잡힌 홈에서 두 번째가 소유권을 잡으면 이 검사는 아무것도 지키지 않는다"
    );
    assert!(!guest.owns_writes());

    // ① 잠금이 지키는 쓰기 — 이름을 달고 거절하고, 거절이 저장소를 지목한다.
    match call(&guest, "data_kv_set", json!({ "ns": "t", "key": "k", "value": 1 })) {
        Outcome::Failed(why) => {
            assert!(why.contains("소유"), "거절 사유가 소유권을 말하지 않는다: {why}");
            assert!(
                why.contains(&db.display().to_string()),
                "거절이 어느 저장소인지 지목하지 않는다: {why}"
            );
        }
        Outcome::Ok(_) => panic!("잠금 없이 kv 쓰기가 통과했다 — 잠금이 아무것도 안 지킨다"),
        Outcome::InvalidParams(e) => panic!("인자 모양이 어긋났다: {e}"),
    }

    // ② 잠금 밖의 쓰기 — 답만 성공하는 것이 아니라 **행이 남는다.**
    let before = activity_rows(&db);
    match call(
        &guest,
        "activity_publish",
        json!({ "kind": "test.publish", "source": "writes-outside-the-lock", "payload": {} }),
    ) {
        Outcome::Ok(entry) => {
            assert!(entry.get("seq").is_some(), "도장 찍힌 항목이 아니다: {entry}");
        }
        Outcome::Failed(why) => panic!("원장 적재가 거절됐다: {why}"),
        Outcome::InvalidParams(e) => panic!("인자 모양이 어긋났다: {e}"),
    }
    assert_eq!(
        activity_rows(&db),
        before + 1,
        "publish 가 성공을 답했는데 원장에 행이 없다 — 실측 2026-07-28 의 침묵(24회 성공·0행)이 \
         돌아왔다. 잠금 게이트를 이 경로에 달면 이 자리가 빨개진다"
    );
}
