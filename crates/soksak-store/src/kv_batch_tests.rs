use rusqlite::Connection;
use serde_json::json;

use super::{init_base, kv_delete_many, kv_entries, kv_get, kv_set, MAX_KV_BATCH_KEYS};

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_base(&conn).unwrap();
    conn
}

#[test]
fn entries_return_one_prefix_snapshot_with_decoded_values() {
    let conn = db();
    kv_set(&conn, "core", "window/w-2", &json!({ "n": 2 })).unwrap();
    kv_set(&conn, "core", "window/w-1", &json!({ "n": 1 })).unwrap();
    kv_set(&conn, "core", "windows", &json!({ "slots": [] })).unwrap();
    kv_set(&conn, "other", "window/w-x", &json!({ "n": 9 })).unwrap();

    let out = kv_entries(&conn, "core", Some("window")).unwrap();
    assert_eq!(out.ns, "core");
    assert_eq!(
        out.entries,
        vec![
            super::KvEntry {
                key: "window/w-1".into(),
                value: json!({ "n": 1 })
            },
            super::KvEntry {
                key: "window/w-2".into(),
                value: json!({ "n": 2 })
            },
            super::KvEntry {
                key: "windows".into(),
                value: json!({ "slots": [] })
            },
        ]
    );
}

#[test]
fn entries_treat_prefix_as_literal_not_like_pattern() {
    let conn = db();
    kv_set(&conn, "core", "window/a_b", &json!(1)).unwrap();
    kv_set(&conn, "core", "window/axb", &json!(2)).unwrap();

    let out = kv_entries(&conn, "core", Some("window/a_")).unwrap();
    assert_eq!(
        out.entries
            .iter()
            .map(|e| e.key.as_str())
            .collect::<Vec<_>>(),
        ["window/a_b"]
    );
}

#[test]
fn delete_many_deduplicates_exact_keys_and_reports_absence() {
    let conn = db();
    kv_set(&conn, "core", "window/a", &json!({ "a": 1 })).unwrap();
    kv_set(&conn, "core", "window/ab", &json!({ "keep": true })).unwrap();

    let out = kv_delete_many(
        &conn,
        "core",
        &[
            "window/a".into(),
            "window/a".into(),
            "window/missing".into(),
        ],
    )
    .unwrap();

    assert_eq!(out.ns, "core");
    assert_eq!(out.requested, 2);
    assert_eq!(out.deleted, 1);
    assert_eq!(out.absent, 1);
    assert_eq!(kv_get(&conn, "core", "window/a").unwrap(), None);
    assert_eq!(
        kv_get(&conn, "core", "window/ab").unwrap(),
        Some(json!({ "keep": true }))
    );
}

#[test]
fn delete_many_rejects_empty_keys_and_batch_overflow_before_writing() {
    let conn = db();
    kv_set(&conn, "core", "keep", &json!(1)).unwrap();

    assert!(kv_delete_many(&conn, "core", &["keep".into(), "".into()]).is_err());
    assert_eq!(kv_get(&conn, "core", "keep").unwrap(), Some(json!(1)));

    let too_many = (0..=MAX_KV_BATCH_KEYS)
        .map(|i| format!("k-{i}"))
        .collect::<Vec<_>>();
    assert!(kv_delete_many(&conn, "core", &too_many).is_err());
    assert_eq!(kv_get(&conn, "core", "keep").unwrap(), Some(json!(1)));
}

#[test]
fn delete_many_accepts_the_exact_4096_key_boundary() {
    let conn = db();
    let boundary = (0..MAX_KV_BATCH_KEYS)
        .map(|i| format!("missing-{i}"))
        .collect::<Vec<_>>();

    let out = kv_delete_many(&conn, "core", &boundary).unwrap();
    assert_eq!(out.requested, MAX_KV_BATCH_KEYS);
    assert_eq!(out.deleted, 0);
    assert_eq!(out.absent, MAX_KV_BATCH_KEYS);
}

#[test]
fn delete_many_is_one_transaction_even_when_a_later_exact_delete_fails() {
    let conn = db();
    kv_set(&conn, "core", "first", &json!(1)).unwrap();
    kv_set(&conn, "core", "blocked", &json!(2)).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_blocked BEFORE DELETE ON kv \
         WHEN old.ns='core' AND old.k='blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
    )
    .unwrap();

    assert!(kv_delete_many(&conn, "core", &["first".into(), "blocked".into()]).is_err());
    assert_eq!(kv_get(&conn, "core", "first").unwrap(), Some(json!(1)));
    assert_eq!(kv_get(&conn, "core", "blocked").unwrap(), Some(json!(2)));
}
