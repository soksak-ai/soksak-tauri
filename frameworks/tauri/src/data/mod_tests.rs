use std::path::{Path, PathBuf};

// 홈이 인자라는 것의 요점 — 답이 프로세스가 아니라 입력으로 결정된다.
// 이 단언이 없으면 db_path_in 이 앰비언트로 되돌아가도 아무도 모른다(그 오답은
// 조용하다: 거부가 아니라 다른 identity 의 DB 를 여는 것으로 끝난다).
#[test]
fn the_db_path_follows_the_home_it_is_given() {
    let base = std::env::temp_dir().join(format!("dbpath-{}", std::process::id()));
    let a = base.join("home-a");
    let b = base.join("home-b");
    let pa = super::db_path_in(&a).unwrap();
    let pb = super::db_path_in(&b).unwrap();
    assert_ne!(pa, pb, "두 홈이 같은 DB 를 가리킨다");
    assert!(pa.starts_with(&a), "{pa:?} 가 홈 밖이다");
    assert!(pb.starts_with(&b), "{pb:?} 가 홈 밖이다");
    let _ = std::fs::remove_dir_all(&base);
}

// SOKSAK_DATA_DIR(debug 전용)이 데이터 디렉토리를 지정 — e2e 가 홈의 설치본 플러그인·사이드카는 그대로
// 두고 DB 만 disposable temp 로 격리한다. 빈 값·부재는 홈/data 폴백. release 엔 이 분기가 없어
// (cfg debug_assertions) 이 계약도 debug 에서만 검증한다(새 프로덕션 DB-override 표면 부재의 대칭).
#[cfg(debug_assertions)]
#[test]
fn data_dir_env_overrides_data_dir_in_debug() {
    use super::data_dir_from;
    assert_eq!(
        data_dir_from(Some("/tmp/e2e-data"), Path::new("/home/max/.soksak-debug")),
        PathBuf::from("/tmp/e2e-data"),
        "SOKSAK_DATA_DIR 이 데이터 디렉토리를 그대로 지정"
    );
    assert_eq!(
        data_dir_from(Some(""), Path::new("/home/max/.soksak-debug")),
        PathBuf::from("/home/max/.soksak-debug/data"),
        "빈 값은 무시 → 홈/data 폴백"
    );
    assert_eq!(
        data_dir_from(None, Path::new("/home/max/.soksak-debug")),
        PathBuf::from("/home/max/.soksak-debug/data"),
        "부재 → 홈/data 폴백"
    );
}
