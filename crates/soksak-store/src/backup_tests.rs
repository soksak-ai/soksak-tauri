use super::*;
use crate::open;
use serde_json::json;

fn mem_file(dir: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    dir.join(name)
}

// 들어오는 길의 규칙 — import 가 ns 를 검증하지 않으면 나머지 표면이 주소로 삼을 수 없는 데이터가
// 저장소에 앉는다(실측: "plugin:probe-lane"). 규칙은 모든 입구에서 같아야 규칙이다.
#[test]
fn import_refuses_a_namespace_the_rest_of_the_surface_cannot_address() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    store::init_base(&conn).unwrap();
    let bad = r#"{"kind":"kv","ns":"plugin:probe-lane","k":"x","v":{"a":1}}"#;
    let err = import(&conn, bad).unwrap_err();
    assert!(err.contains("ns"), "거부 이유가 ns 를 지목한다: {err}");

    let good = r#"{"kind":"kv","ns":"soksak-plugin-probe","k":"x","v":{"a":1}}"#;
    assert_eq!(import(&conn, good).unwrap(), 1);
}

#[test]
fn backup_restore_roundtrip() {
    let root = std::env::temp_dir().join(format!("soksak-data-bk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let db = mem_file(&root, "soksak.db");

    let conn = open::open(&db).unwrap();
    store::define(&conn, "mailbox", "messages", &[], &["title".into()]).unwrap();
    store::put(
        &conn,
        "mailbox",
        "messages",
        "p",
        None,
        &json!({"title":"백업 한글"}),
    )
    .unwrap();
    let snap = root.join("snap.db");
    backup(&conn, &snap).unwrap();
    drop(conn);

    // 후보 검증.
    validate(&snap).unwrap();
    assert!(validate(&root.join("nope.db")).is_err());

    // 복원 후 동일 데이터 + 검색 동작.
    let bak = restore_into(&db, &snap).unwrap();
    assert!(bak.exists());
    let conn2 = open::open(&db).unwrap();
    assert_eq!(
        store::search(&conn2, "mailbox", "messages", "백업", None, None, None)
            .unwrap()
            .len(),
        1
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn export_import_roundtrip() {
    let c = Connection::open_in_memory().unwrap();
    store::init_base(&c).unwrap();
    store::define(
        &c,
        "mailbox",
        "messages",
        &["read".into()],
        &["title".into()],
    )
    .unwrap();
    store::put(
        &c,
        "mailbox",
        "messages",
        "p",
        Some("m1".into()),
        &json!({"title":"이식 테스트","read":false}),
    )
    .unwrap();
    store::kv_set(&c, "mailbox", "cfg", &json!({"on":true})).unwrap();

    let dump = export(&c, Some("mailbox"), None).unwrap();
    assert!(dump.contains("\"kind\":\"meta\""));
    assert!(dump.contains("\"kind\":\"record\""));
    assert!(dump.contains("\"kind\":\"kv\""));

    let c2 = Connection::open_in_memory().unwrap();
    store::init_base(&c2).unwrap();
    let n = import(&c2, &dump).unwrap();
    assert_eq!(n, 2); // 1 record + 1 kv
    assert_eq!(
        store::get(&c2, "mailbox", "messages", "m1", None, None)
            .unwrap()
            .unwrap()
            .get("title")
            .unwrap(),
        "이식 테스트"
    );
    assert_eq!(
        store::search(&c2, "mailbox", "messages", "이식", None, None, None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store::kv_get(&c2, "mailbox", "cfg").unwrap(),
        Some(json!({"on":true}))
    );
}
