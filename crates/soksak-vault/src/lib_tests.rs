// 볼트의 검사 — 규칙은 lib.rs 가, 그 증명은 여기가 진다.
//
// 실 키체인을 안 만진다. KEK 는 주입 이음매(InMemoryKekSource·FailingKekSource)로 들어오고,
// 볼트 파일은 임시 디렉터리에 난다 — 그래서 어느 프로세스에서 돌든 같은 답을 낸다.
use super::*;

fn kek_a() -> Zeroizing<[u8; KEK_LEN]> {
    derive_kek(
        b"correct horse",
        b"salt-aaaa-bbbb-cc",
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )
    .unwrap()
}

// 임시 볼트 dir+path — 전역 HOME 변이 0(병렬 test-threads 레이스 제거). KEK 출처는 미주입 —
// 호출자가 InMemory/Failing 을 골라 넣는다(같은 path 에 다른 KEK 재주입으로 정합/불일치 재현).
fn tmp_vault_dir(tag: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "soksak-secrets-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("secrets.vault");
    (dir, path)
}

// 임시 볼트 + InMemory KEK 주입 state(투명 언락) — set_var 0·키체인 미접촉. 대부분의 왕복 테스트용.
fn state_with_tmp_vault(tag: &str) -> (SecretsState, PathBuf) {
    let (dir, path) = tmp_vault_dir(tag);
    let s = SecretsState::default();
    s.set_path(path);
    s.set_kek_source(Box::new(InMemoryKekSource::empty()));
    (s, dir)
}

// (e2e) E2eKekSource 결정성 — 같은 값 → 같은 KEK(격리 볼트 런 간 재오픈 가능), 다른 값 → 다른 KEK.
// release 엔 이 타입이 컴파일되지 않으므로 이 테스트도 debug 에서만 돈다(백도어 부재의 대칭).
#[cfg(debug_assertions)]
#[test]
fn e2e_kek_is_deterministic() {
    let a = E2eKekSource::derive("pty-cold-e2e-pass");
    assert_eq!(
        a,
        E2eKekSource::derive("pty-cold-e2e-pass"),
        "같은 값 → 같은 KEK"
    );
    assert_ne!(a, E2eKekSource::derive("other"), "다른 값 → 다른 KEK");
    assert_ne!(a, [0u8; KEY_LEN], "0 KEK 아님");
}

// (a0) resolve_vault_path — SOKSAK_VAULT_PATH 주입 시 그 경로(격리), 없으면 정체성 파생.
// 오픈 메커니즘: 헤드리스/E2E 가 사용자 실볼트를 오염하지 않게 경로를 격리한다(passphrase 비종속).
#[test]
fn vault_path_env_override() {
    let id = Identity::new("/tmp/x-dev", "com.soksak.dev");
    let iso = std::env::temp_dir()
        .join("soksak-vault-override-test")
        .join("secrets.vault");
    let chosen = resolve_vault_path(
        |k| {
            if k == "SOKSAK_VAULT_PATH" {
                Some(iso.to_string_lossy().into_owned())
            } else {
                None
            }
        },
        &id,
    )
    .unwrap();
    assert_eq!(chosen, iso, "SOKSAK_VAULT_PATH 주입 → 그 경로");
    // 미주입 → 이 정체성의 볼트(프로덕션 경로 규칙 유지).
    let fallback = resolve_vault_path(|_| None, &id).unwrap();
    assert_eq!(fallback, vault_path(&id), "미주입 → 정체성 파생");
    // 빈 문자열 → 정체성 파생(빈 env 를 '설정 안 함' 으로 취급).
    let empty = resolve_vault_path(
        |k| {
            if k == "SOKSAK_VAULT_PATH" {
                Some(String::new())
            } else {
                None
            }
        },
        &id,
    )
    .unwrap();
    assert_eq!(empty, vault_path(&id), "빈 env → 정체성 파생");
}

// ── 정체성 계약(cored 이행 준비) ──────────────────────────────────────────────
// 볼트 경로가 안 주어졌을 때 전역 홈으로 슬쩍 폴백하면, 그 코드는 "이 프로세스가 앱이다"를
// 전제한다. cored 로 옮기는 순간 같은 코드가 남의 홈(~/.soksak)에 볼트를 만든다 — 조용히.
// home::soksak_home() 은 init 전에도 ~/.soksak 을 돌려주므로 폴백은 언제나 '성공'한다.
#[test]
fn an_unconfigured_vault_never_falls_back_to_the_ambient_home() {
    let s = SecretsState::default();
    let err = s
        .vault_file()
        .expect_err("경로 미구성은 이름을 달고 실패해야 한다");
    assert!(
        err.contains("볼트 경로 미구성"),
        "미구성이 폴백으로 삼켜졌다: {err:?}"
    );
}

// 볼트는 정체성의 것이다 — 홈이 다르면 볼트가 다르고, 그 사실이 값으로 증명된다.
// (전역을 한 번도 안 읽고 임의 정체성의 볼트 경로를 얻는 것이 이 계약의 요점이다.)
#[test]
fn a_vault_belongs_to_an_identity_not_to_a_process() {
    let dev = Identity::new("/tmp/x-dev", "com.soksak.dev");
    let debug = Identity::new("/tmp/x-debug", "com.soksak.debug");
    assert_eq!(vault_path(&dev), Path::new("/tmp/x-dev/secrets.vault"));
    assert_ne!(vault_path(&dev), vault_path(&debug), "홈이 다르면 볼트도 다르다");
}

// 정체성만 주면 쓸 수 있는 볼트가 된다 — 앱도 창도 전역도 없이 봉인·개봉이 왕복한다.
// 주입 형태는 lib.rs 부트와 같다(경로·KEK 를 정체성에서 파생해 seam 으로 넣는다) — 이 테스트가
// Tauri 타입을 한 개도 안 쓰고 컴파일·통과한다는 사실이 이행 가능성의 증명이다.
#[test]
fn a_state_built_from_an_identity_needs_no_shell() {
    let (dir, _path) = tmp_vault_dir("identity-home");
    let id = Identity::new(&dir, "com.soksak.dev");
    let s = SecretsState::default();
    s.set_path(vault_path(&id));
    s.set_kek_source(Box::new(InMemoryKekSource::empty()));
    s.set("plugin-a", "apiKey", "sk-token").expect("봉인");
    assert_eq!(s.resolve("plugin-a", "apiKey").unwrap(), "sk-token");
    // 볼트가 정확히 그 정체성의 홈 아래에 생겼다 — 전역 홈이 아니다.
    assert!(vault_path(&id).exists(), "정체성 홈 아래 볼트 파일");
    let _ = std::fs::remove_dir_all(&dir);
}

// 구 backend 투영은 커맨드 안이 아니라 값 위에 있어야 한다 — 커맨드 안에 있으면 창 없는
// 프로세스는 같은 답을 만들 수 없다(핸들러는 위임만 한다).
#[test]
fn the_backend_projection_lives_on_the_value_not_in_the_handler() {
    let (s, dir) = state_with_tmp_vault("backend-proj");
    let info = BackendInfo::from(s.status());
    assert_eq!(info.backend, "memory");
    assert!(info.unlocked, "unlocked = seal_available");
    let f = SecretsState::default();
    f.set_kek_source(Box::new(FailingKekSource));
    let down = BackendInfo::from(f.status());
    assert_eq!(down.backend, "unavailable");
    assert!(!down.unlocked);
    let _ = std::fs::remove_dir_all(&dir);
}


// (a) seal → open roundtrip — 같은 KEK 로 봉인·개봉 시 평문 복원.
#[test]
fn seal_open_roundtrip() {
    let kek = kek_a();
    let item = seal(&kek, b"sk-secret-token-123").unwrap();
    let plain = open(&kek, &item).unwrap();
    assert_eq!(plain, b"sk-secret-token-123");
}

// (b) wrong KEK → open Err — AEAD 인증이 잘못된 키를 거부(평문 누출 0).
#[test]
fn wrong_kek_rejected() {
    let kek = kek_a();
    let item = seal(&kek, b"value").unwrap();
    let wrong = derive_kek(
        b"wrong pass",
        b"salt-aaaa-bbbb-cc",
        ARGON2_M_COST,
        ARGON2_T_COST,
        ARGON2_P_COST,
    )
    .unwrap();
    assert!(open(&wrong, &item).is_err());
}

// (c) val_ct/dek_ct 변조 → open Err — 무결성(AEAD 태그 불일치).
#[test]
fn tamper_rejected() {
    let kek = kek_a();
    // val_ct 변조
    let mut item = seal(&kek, b"value").unwrap();
    item.val_ct[0] ^= 0xff;
    assert!(open(&kek, &item).is_err());
    // dek_ct 변조
    let mut item2 = seal(&kek, b"value").unwrap();
    item2.dek_ct[0] ^= 0xff;
    assert!(open(&kek, &item2).is_err());
}

// (d, 신규 test4) KEK↔vault 불일치 거부 + 정합 KEK 재주입 복원(재시작 영속). 다른 기기 키체인
// 백업 복원·키체인 리셋을 verifier 개봉 실패로 loud 하게 잡는다(전손 footgun 차단).
#[test]
fn kek_vault_mismatch_rejected_and_matching_reopens() {
    let (dir, path) = tmp_vault_dir("mismatch");
    let kek_a = [1u8; KEY_LEN];
    let kek_b = [2u8; KEY_LEN];
    // A 로 vault 생성·flush + 시크릿 저장.
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek_a)));
        s.set("plugin-a", "k", "v").expect("A creates vault + stores");
    }
    // 다른 KEK(B) 주입 새 state, 같은 path → verifier 개봉 실패로 열림 거부.
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek_b)));
        assert!(
            !s.is_unlocked(),
            "다른 KEK → vault↔keychain 불일치로 열림 거부"
        );
        assert!(s.resolve("plugin-a", "k").is_err(), "불일치면 개봉 불가");
    }
    // 같은 KEK(A) 재주입 새 state → 복원(재시작 영속).
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek_a)));
        assert!(s.is_unlocked(), "같은 KEK → 복원");
        assert_eq!(s.resolve("plugin-a", "k").unwrap(), "v", "재시작 영속");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// (e) ns 격리 — ns A 의 key 가 ns B keys 에 안 보임(투명 언락 — unlock 호출 없음).
#[test]
fn ns_isolation() {
    let (s, dir) = state_with_tmp_vault("ns");

    s.set("plugin-a", "token", "aaa").unwrap();
    s.set("plugin-b", "key", "bbb").unwrap();

    assert_eq!(s.keys("plugin-a").unwrap(), vec!["token".to_string()]);
    assert_eq!(s.keys("plugin-b").unwrap(), vec!["key".to_string()]);
    assert!(s.has("plugin-a", "token").unwrap());
    assert!(!s.has("plugin-b", "token").unwrap()); // A 의 key 가 B 에 안 보임
    assert!(s.keys("plugin-c").unwrap().is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}

// Registry credentials live in a core-owned namespace class containing `_`. Plugin ids
// cannot contain `_`, so a plugin's ownership-fixed app.secrets namespace can never alias it.
#[test]
fn core_registry_namespace_is_disjoint_and_supported() {
    let (s, dir) = state_with_tmp_vault("core-registry-ns");
    s.set("core_registry-corp", "http-authorization", "Bearer private")
        .expect("core registry namespace must be a valid vault owner");
    assert!(s.has("core_registry-corp", "http-authorization").unwrap());
    assert!(s.set("plugin_with_underscore", "token", "bad").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

// env_secrets(PS9) — ns 의 "env:" 접두 키만 (환경변수명, 평문)으로, 접두 벗기고 정렬. 비-env 키·
// 잠김은 제외. 서비스 vault_env 동적 주입의 바닥(1판 buildSecretEnvMap 등가).
#[test]
fn env_secrets_resolves_env_prefixed_keys() {
    let (dir, path) = tmp_vault_dir("envsec");
    let s = SecretsState::default();
    s.set_path(path.clone());
    s.set_kek_source(Box::new(InMemoryKekSource::with_kek([3u8; KEY_LEN])));
    s.set("wf", "env:ANTHROPIC_AUTH_TOKEN", "tok")
        .expect("set token");
    s.set("wf", "env:CLAUDE_ACCOUNT_NAME", "acct")
        .expect("set acct");
    s.set("wf", "apiKey", "not-env").expect("set non-env"); // 비-env 키는 제외
    let got = env_secrets(&s, "wf");
    assert_eq!(
        got,
        vec![
            ("ANTHROPIC_AUTH_TOKEN".to_string(), "tok".to_string()),
            ("CLAUDE_ACCOUNT_NAME".to_string(), "acct".to_string()),
        ],
        "env: 키만, 접두 제거, 정렬"
    );
    // no-secret-service → 빈 벡터(loud 실패 아님). 같은 path 에 Failing 주입 새 state — 디스크엔
    // 키가 있으나 KEK 미도달이라 keys() Err → 빈 벡터(우아한 잠김).
    let locked = SecretsState::default();
    locked.set_path(path);
    locked.set_kek_source(Box::new(FailingKekSource));
    assert!(
        env_secrets(&locked, "wf").is_empty(),
        "KEK 미도달이면 빈 벡터"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// locked 상태에서 연산 거부.
#[test]
fn locked_ops_rejected() {
    let s = SecretsState::default();
    assert!(s.set("ns", "k", "v").is_err());
    assert!(s.has("ns", "k").is_err());
    assert!(s.keys("ns").is_err());
    assert!(s.delete("ns", "k").is_err());
}

// resolve(내부 평문 해소) — 투명 언락으로 저장값 평문 복원(process_spawn 주입 경로의 바닥).
#[test]
fn resolve_roundtrip() {
    let (s, dir) = state_with_tmp_vault("resolve");
    s.set("plugin-a", "apiKey", "sk-token-xyz").unwrap();
    assert_eq!(s.resolve("plugin-a", "apiKey").unwrap(), "sk-token-xyz");
    let _ = std::fs::remove_dir_all(&dir);
}

// (신규 test2) os_key seam 봉인/개봉 왕복 — unlock 호출 없이(투명) set→resolve·put_data_key→
// get_data_key 라운드트립(KEK 가 주입 store 에서 온다). 봉인 경로 정합 증명.
#[test]
fn os_key_seam_seal_open_roundtrip() {
    let (s, dir) = state_with_tmp_vault("seam");
    s.set("plugin-a", "apiKey", "sk-token").unwrap();
    assert_eq!(s.resolve("plugin-a", "apiKey").unwrap(), "sk-token");
    let (sk, _p) = gen_asym_keypair();
    s.put_data_key("dk-1", &sk).unwrap();
    assert_eq!(s.get_data_key("dk-1").unwrap().unwrap(), sk, "봉투 개인키 왕복");
    let _ = std::fs::remove_dir_all(&dir);
}

// (신규 test3) no-secret-service — Failing 주입: 쓰기(set/put_data_key)는 loud Err(무음 평문 금지),
// 읽기(get_data_key)는 Ok(None)(우아한 잠김). vault 파일도 안 생긴다(평문 저장 경로 부재).
#[test]
fn no_secret_service_seals_impossible() {
    let (dir, path) = tmp_vault_dir("no-service");
    let s = SecretsState::default();
    s.set_path(path.clone());
    s.set_kek_source(Box::new(FailingKekSource));
    assert!(!s.is_unlocked(), "KEK 미도달 → 잠김");
    assert!(
        s.set("plugin-a", "k", "v").is_err(),
        "봉인 불가 → 무음 평문 금지(loud Err)"
    );
    let (sk, _p) = gen_asym_keypair();
    assert!(s.put_data_key("dk-1", &sk).is_err(), "봉투 개인키 저장 loud Err");
    assert!(
        s.get_data_key("dk-1").unwrap().is_none(),
        "읽기는 우아하게 None"
    );
    assert!(!path.exists(), "봉인 불가 시 vault 파일도 안 생김(평문 저장 0)");
    let _ = std::fs::remove_dir_all(&dir);
}

// (신규 test6) secret_status — InMemory: seal_available·backend"memory"·data_key_ids 반영.
// Failing: seal_available false·backend"unavailable". expect_vault 반영.
#[test]
fn secret_status_reports_backend_and_keys() {
    let (s, dir) = state_with_tmp_vault("status");
    let (sk, _p) = gen_asym_keypair();
    s.put_data_key("dk-1", &sk).unwrap();
    let st = s.status();
    assert!(st.seal_available, "InMemory 는 도달 가능");
    assert_eq!(st.backend, "memory");
    assert_eq!(st.data_key_ids, vec!["dk-1".to_string()], "보관 keyId 목록");
    assert!(!st.expect_vault);
    s.set_expect_vault(true);
    assert!(s.status().expect_vault, "expect_vault 반영");

    // Failing → seal_available false·backend unavailable·data_key_ids 빈(프로브가 vault 안 엶).
    let (dir2, path2) = tmp_vault_dir("status-fail");
    let f = SecretsState::default();
    f.set_path(path2);
    f.set_kek_source(Box::new(FailingKekSource));
    let fs = f.status();
    assert!(!fs.seal_available);
    assert_eq!(fs.backend, "unavailable");
    assert!(fs.data_key_ids.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}

// ── 비대칭 봉투(단계②) ──────────────────────────────────────────────────
const AAD1: &[u8] = b"terminal|command_blocks|proj-a|rec-1|key-1|1";
const AAD2: &[u8] = b"terminal|command_blocks|proj-b|rec-1|key-1|1"; // scope 만 다름

// (asym-a) seal_to(P) → open_sealed(S) roundtrip — 같은 키페어·같은 AAD 면 평문 복원.
#[test]
fn asym_seal_open_roundtrip() {
    let (s, p) = gen_asym_keypair();
    let msg = br#"{"id":"rec-1","output":"secret echo"}"#;
    let boxed = seal_to(&p, msg, AAD1).unwrap();
    assert_eq!(open_sealed(&s, &boxed, AAD1).unwrap(), msg);
}

// (asym-b, blocker④) P == basepoint(S) — public_from_secret(S) 가 키페어 P 와 byte-eq.
// 키스왑 거부의 토대: encryption_keys.publicKey 가 S 에서 파생됐는지 검증할 수 있다.
#[test]
fn asym_public_matches_basepoint() {
    let (s, p) = gen_asym_keypair();
    assert_eq!(public_from_secret(&s), p, "P 는 basepoint·S 와 일치해야");
    // 다른 S 의 P 는 다르다(스왑된 P 는 검증에서 탈락).
    let (s2, _p2) = gen_asym_keypair();
    assert_ne!(
        public_from_secret(&s2),
        p,
        "다른 S → 다른 P(스왑 탐지 가능)"
    );
}

// (asym-c, blocker high) AAD 불일치 → open Err. scope 만 바뀐 AAD 로 개봉 거부(교차-scope 누출 0).
#[test]
fn asym_aad_mismatch_rejected() {
    let (s, p) = gen_asym_keypair();
    let boxed = seal_to(&p, b"value", AAD1).unwrap();
    assert!(
        open_sealed(&s, &boxed, AAD2).is_err(),
        "다른 AAD 면 개봉 거부"
    );
    assert!(open_sealed(&s, &boxed, b"").is_err(), "빈 AAD 면 개봉 거부");
    assert_eq!(open_sealed(&s, &boxed, AAD1).unwrap(), b"value"); // 정합 AAD 는 성공
}

// (asym-d) 잘못된 개인키 → open Err. 변조(ct/eph_pk) → open Err(평문 누출 0).
#[test]
fn asym_wrong_key_and_tamper_rejected() {
    let (_s, p) = gen_asym_keypair();
    let (s_other, _p2) = gen_asym_keypair();
    let boxed = seal_to(&p, b"value", AAD1).unwrap();
    assert!(
        open_sealed(&s_other, &boxed, AAD1).is_err(),
        "타 개인키 거부"
    );
    // ct 변조
    let (s, p) = gen_asym_keypair();
    let mut t1 = seal_to(&p, b"value", AAD1).unwrap();
    t1.ct[0] ^= 0xff;
    assert!(open_sealed(&s, &t1, AAD1).is_err(), "ct 변조 거부");
    // eph_pk 변조 → DH 키 달라짐 → 인증 실패
    let mut t2 = seal_to(&p, b"value", AAD1).unwrap();
    t2.eph_pk[0] ^= 0xff;
    assert!(open_sealed(&s, &t2, AAD1).is_err(), "eph_pk 변조 거부");
}

// (r24, B10) recovery code — S 를 코드로 wrap/unwrap 라운드트립. 잘못된 코드 거부. 구분자/대소문자
// 무관 정규화. 코드는 typeable(Crockford base32, 혼동문자 없음).
#[test]
fn recovery_code_roundtrip() {
    let (s, _p) = gen_asym_keypair();
    let code = gen_recovery_code();
    // 코드 형식 — 대시 그룹, 혼동문자(I L O U) 없음.
    assert!(code.contains('-'), "그룹 구분 대시");
    for c in code.chars().filter(|c| *c != '-') {
        assert!(
            "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c),
            "Crockford 문자만: {c}"
        );
    }
    let (salt, sealed) = recovery_wrap(&code, &s).unwrap();
    // 정확한 코드 → 복구.
    assert_eq!(
        recovery_unwrap(&code, &salt, &sealed).unwrap(),
        s,
        "코드로 S 복구"
    );
    // 구분자/소문자 섞어도 동일(정규화).
    let messy = code.to_lowercase().replace('-', " ");
    assert_eq!(
        recovery_unwrap(&messy, &salt, &sealed).unwrap(),
        s,
        "정규화 후 동일 복구"
    );
    // 잘못된 코드 → 거부(AEAD).
    assert!(
        recovery_unwrap("WRONG-CODE-0000", &salt, &sealed).is_err(),
        "잘못된 코드 거부"
    );
    // blob 직렬화 라운드트립.
    let blob = RecoveryBlob {
        salt: salt.clone(),
        sealed: sealed.clone(),
    };
    let json = serde_json::to_string(&blob).unwrap();
    let back: RecoveryBlob = serde_json::from_str(&json).unwrap();
    assert_eq!(recovery_unwrap(&code, &back.salt, &back.sealed).unwrap(), s);
}

// (r23, B8, 신규 test5) vault must-exist — 봉투 키가 등록된 상태(expect_vault)에서 vault 파일이
// 없으면 ensure_open 이 새 vault 자동생성을 거부한다(전손 차단). expect 없으면 정상 생성(첫 실행).
#[test]
fn vault_must_exist_gate() {
    let (dir, path) = tmp_vault_dir("mustexist");
    let kek = [5u8; KEY_LEN];
    // 첫 실행 — expect 없음 → 새 vault 자동 생성.
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek)));
        assert!(s.is_unlocked(), "첫 실행 — 투명 개방으로 자동 생성");
    }
    assert!(path.exists());
    // vault 파일 삭제(손실 모의).
    std::fs::remove_file(&path).unwrap();
    // 키 등록됨(expect_vault) + 파일 부재 → 새 state 는 자동생성 거부(R23).
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek)));
        s.set_expect_vault(true);
        assert!(!s.is_unlocked(), "vault 부재+키등록 → 자동생성 거부");
        assert!(!path.exists(), "거부 시 파일 생성 안 함");
    }
    // expect 끄면(키 없음) 다시 생성 허용.
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek)));
        s.set_expect_vault(false);
        assert!(s.is_unlocked(), "expect 없으면 새 vault 생성 허용");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// (r24, red-team) 복구 부트스트랩 — 파일 부재 + 봉투 키 등록(expect_vault)이라 투명 개방이 막힌
// deadlock 상태에서도 recover_into_vault 가 이 기계 KEK 로 vault 를 확보해 복구된 S 를 저장한다.
// is_unlocked 게이트로 막던 "정확한 코드로도 못 여는 이관 deadlock" 회귀를 이 테스트가 잡는다.
#[test]
fn recover_into_vault_bootstraps_when_absent() {
    let (dir, path) = tmp_vault_dir("recboot");
    let kek = [7u8; KEY_LEN];
    let s = [9u8; 32];
    let st = SecretsState::default();
    st.set_path(path.clone());
    st.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek)));
    st.set_expect_vault(true);
    assert!(!st.is_unlocked(), "복구 상태 — 투명 개방 불가(deadlock 전제)");
    st.recover_into_vault("key-1", &s).unwrap();
    assert!(st.is_unlocked(), "복구 후 vault 열림");
    assert_eq!(st.get_data_key("key-1").unwrap().unwrap(), s, "복구된 S 저장·조회");
    assert!(path.exists(), "복구가 vault 파일 확보");
    // 둘째 scope 복구 — 이미 열린 vault 에 추가(기존 S 보존, 새로 만들지 않음).
    let s2 = [11u8; 32];
    st.recover_into_vault("key-2", &s2).unwrap();
    assert_eq!(st.get_data_key("key-1").unwrap().unwrap(), s, "첫 S 보존");
    assert_eq!(st.get_data_key("key-2").unwrap().unwrap(), s2, "둘째 S 추가");
    let _ = std::fs::remove_dir_all(&dir);
}

// (r24, red-team) 폴더 통째 sync — vault 파일은 있으나 옛 기계 KEK 로 봉인돼 이 기계 KEK 로는 안 열린다.
// recover_into_vault 가 현재 KEK 로 vault 를 대체하고 복구된 S 를 저장한다. 옛 KEK 전용 S 는 코드 없이
// 어차피 접근 불가였으므로 대체돼도 복구가능한 것 손실 0.
#[test]
fn recover_into_vault_replaces_foreign_kek_vault() {
    let (dir, path) = tmp_vault_dir("recforeign");
    let kek_a = [1u8; KEY_LEN];
    let kek_b = [2u8; KEY_LEN];
    let s = [9u8; 32];
    {
        let a = SecretsState::default();
        a.set_path(path.clone());
        a.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek_a)));
        a.put_data_key("old-a", &[3u8; 32]).unwrap();
    }
    assert!(path.exists());
    let b = SecretsState::default();
    b.set_path(path.clone());
    b.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek_b)));
    b.set_expect_vault(true);
    assert!(!b.is_unlocked(), "외래 KEK vault — 못 엶(deadlock 전제)");
    b.recover_into_vault("key-1", &s).unwrap();
    assert!(b.is_unlocked(), "복구 후 이 기계 KEK vault 열림");
    assert_eq!(b.get_data_key("key-1").unwrap().unwrap(), s, "복구된 S 저장");
    assert!(
        b.get_data_key("old-a").unwrap().is_none(),
        "옛 KEK 전용 S 는 대체됨(어차피 이 기계서 복구 불가였다)"
    );
    // 무손실 — 옛 외래-KEK vault 는 삭제가 아니라 .superseded 로 보존(옛 키체인 복원 시 살릴 여지).
    let backup = PathBuf::from(format!("{}.superseded", path.to_string_lossy()));
    assert!(backup.exists(), "옛 vault 는 .superseded 로 보존되어야 한다");
    let _ = std::fs::remove_dir_all(&dir);
}

// (asym-f) app.data 봉투 개인키 vault 보관 — wrap/unwrap 라운드트립, 재시작 디스크 영속, 삭제.
#[test]
fn data_key_vault_roundtrip() {
    let (dir, path) = tmp_vault_dir("datakey");
    let kek = [6u8; KEY_LEN];
    let (sk, _p) = gen_asym_keypair();
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek)));
        s.put_data_key("key-1", &sk).unwrap();
        assert_eq!(
            s.get_data_key("key-1").unwrap().unwrap(),
            sk,
            "KEK wrap/unwrap 라운드트립"
        );
        assert!(s.get_data_key("key-2").unwrap().is_none(), "미존재 키 None");
    }
    // 재시작 영속 — 같은 device KEK 새 state 가 디스크에서 복원.
    {
        let s = SecretsState::default();
        s.set_path(path.clone());
        s.set_kek_source(Box::new(InMemoryKekSource::with_kek(kek)));
        assert_eq!(
            s.get_data_key("key-1").unwrap().unwrap(),
            sk,
            "재시작 복원(디스크 영속)"
        );
        assert!(s.delete_data_key("key-1").unwrap());
        assert!(s.get_data_key("key-1").unwrap().is_none(), "삭제 후 None");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// (asym-e) 봉투 직렬화 라운드트립 — doc 컬럼 문자열로 직렬화/역직렬화 후 개봉 가능(저장 경로 검증).
#[test]
fn asym_serialize_roundtrip() {
    let (s, p) = gen_asym_keypair();
    let boxed = seal_to(&p, b"persisted", AAD1).unwrap();
    let json = serde_json::to_string(&boxed).unwrap();
    let back: SealedBox = serde_json::from_str(&json).unwrap();
    assert_eq!(open_sealed(&s, &back, AAD1).unwrap(), b"persisted");
}

// resolve 잠금/미존재 게이트 — KEK 미도달=Err, 미존재 key/ns=Err(평문 누출 0).
#[test]
fn resolve_locked_and_missing_rejected() {
    let (dir, path) = tmp_vault_dir("resolve-gate");
    let s = SecretsState::default();
    s.set_path(path.clone());
    s.set_kek_source(Box::new(InMemoryKekSource::with_kek([7u8; KEY_LEN])));
    // 미존재 key/ns → Err(평문 누출 0).
    assert!(s.resolve("plugin-a", "apiKey").is_err(), "미존재 → Err");
    s.set("plugin-a", "apiKey", "v").unwrap();
    assert!(s.resolve("plugin-a", "nope").is_err(), "미존재 key");
    assert!(s.resolve("plugin-z", "apiKey").is_err(), "미존재 ns");
    assert_eq!(s.resolve("plugin-a", "apiKey").unwrap(), "v");
    // no-secret-service(잠김) → Err. 같은 path 에 Failing 주입 새 state.
    let locked = SecretsState::default();
    locked.set_path(path);
    locked.set_kek_source(Box::new(FailingKekSource));
    assert!(
        locked.resolve("plugin-a", "apiKey").is_err(),
        "KEK 미도달 → Err"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// (0600) flush 는 볼트 파일을 로컬 사용자 전용(0600)으로 잠근다 — 그룹/타 사용자 read 차단.
// 투명 개방이 새 vault 를 생성·flush 하므로 결과 파일 mode 를 단언. set(재-flush) 후에도 유지.
// Unix 전용 — Windows 는 파일 퍼미션 개념이 없어(기본 ACL) 이 단언이 무의미.
#[cfg(unix)]
#[test]
fn vault_file_is_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let (s, dir) = state_with_tmp_vault("perm0600");
    assert!(s.is_unlocked(), "투명 개방으로 새 vault 생성 → flush");
    let path = s.vault_file().unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "볼트 파일은 0600 이어야");
    // 재-flush(set) 후에도 0600 유지(rename 이 tmp 퍼미션 보존).
    s.set("plugin-a", "k", "v").unwrap();
    let mode2 = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode2 & 0o777, 0o600, "재-flush 후에도 0600");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── KEK 취득(get-or-create)의 검사 ──

// 인메모리 store — 실 키체인 미접촉(set_var 0, keyring 미호출). write 횟수를 기록해
// "무음 재생성 없음"(Corrupt 시 write 미호출)까지 검증한다.
struct MemoryKeyStore {
    slot: Mutex<Option<String>>,
    writes: Mutex<u32>,
}

impl MemoryKeyStore {
    fn empty() -> Self {
        Self {
            slot: Mutex::new(None),
            writes: Mutex::new(0),
        }
    }
    fn seeded(value: &str) -> Self {
        Self {
            slot: Mutex::new(Some(value.to_string())),
            writes: Mutex::new(0),
        }
    }
    fn writes(&self) -> u32 {
        *self.writes.lock().unwrap()
    }
    fn peek(&self) -> Option<String> {
        self.slot.lock().unwrap().clone()
    }
}

impl SecretStore for MemoryKeyStore {
    fn read(&self) -> Result<Option<String>, KekError> {
        Ok(self.slot.lock().unwrap().clone())
    }
    fn write(&self, secret: &str) -> Result<(), KekError> {
        *self.writes.lock().unwrap() += 1;
        *self.slot.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }
}

// 헤드리스/무 D-Bus 시뮬레이션 — read/write 가 항상 StoreUnavailable.
struct UnavailableStore;
impl SecretStore for UnavailableStore {
    fn read(&self) -> Result<Option<String>, KekError> {
        Err(KekError::StoreUnavailable("no secret-service".to_string()))
    }
    fn write(&self, _secret: &str) -> Result<(), KekError> {
        Err(KekError::StoreUnavailable("no secret-service".to_string()))
    }
}

// 생성 후 재조회 안정 — 같은 store 로 2회 호출 시 동일 KEK, 2회차는 write 안 함.
#[test]
fn create_then_read_stable() {
    let store = MemoryKeyStore::empty();
    let first = get_or_create_kek(&store).expect("create");
    let second = get_or_create_kek(&store).expect("read back");
    assert_eq!(first.as_ref(), second.as_ref(), "생성 후 재조회 안정");
    assert_eq!(store.writes(), 1, "재조회는 write 안 함(기존 값 반환)");
}

// 서로 다른 빈 store 2개 → 서로 다른 KEK(OsRng 랜덤 확인).
#[test]
fn absent_stores_yield_random() {
    let a = get_or_create_kek(&MemoryKeyStore::empty()).expect("a");
    let b = get_or_create_kek(&MemoryKeyStore::empty()).expect("b");
    assert_ne!(a.as_ref(), b.as_ref(), "빈 store 2개 → 서로 다른 랜덤 KEK");
}

// 손상 blob → Err(Corrupt), 그리고 write 미호출·슬롯 불변(무음 재생성 금지 회귀 가드).
#[test]
fn corrupt_blob_rejected() {
    // (1) 비-base64
    let bad = MemoryKeyStore::seeded("not-base64!!");
    let before = bad.peek();
    assert!(
        matches!(get_or_create_kek(&bad), Err(KekError::Corrupt(_))),
        "비base64 → Corrupt"
    );
    assert_eq!(bad.writes(), 0, "Corrupt 는 재생성(write) 금지");
    assert_eq!(bad.peek(), before, "슬롯 값 불변(무음 재생성 없음)");

    // (2) 31B — 유효 base64지만 32B 미달
    let short = STANDARD.encode([7u8; 31]);
    let bad2 = MemoryKeyStore::seeded(&short);
    assert!(
        matches!(get_or_create_kek(&bad2), Err(KekError::Corrupt(_))),
        "31B → Corrupt"
    );
    assert_eq!(bad2.writes(), 0, "길이 미달도 재생성 금지");
}

// 미도달 store → get_or_create_kek 이 Err(StoreUnavailable) 전파(Ok 폴백 아님). 무음 폴백 금지 가드.
#[test]
fn unavailable_surfaces_error() {
    let result = get_or_create_kek(&UnavailableStore);
    assert!(
        matches!(result, Err(KekError::StoreUnavailable(_))),
        "무음 폴백 금지 — StoreUnavailable 를 그대로 표면화해야"
    );
}

// decode_kek 경계 단위 — 정확히 32B 만 통과, 그 외 길이·디코드 실패는 Corrupt.
#[test]
fn decode_length_gate() {
    let exact = STANDARD.encode([9u8; KEK_LEN]);
    assert_eq!(decode_kek(&exact).unwrap().as_ref(), &[9u8; KEK_LEN]);

    let long = STANDARD.encode([1u8; 33]);
    assert!(
        matches!(decode_kek(&long), Err(KekError::Corrupt(_))),
        "33B → Corrupt"
    );
    assert!(
        matches!(decode_kek("@@@@"), Err(KekError::Corrupt(_))),
        "디코드 실패 → Corrupt"
    );
}

// zeroize 는 drop 스크럽이라 직접 관측 불가 — 정직하게 타입으로만 증명한다. 반환 타입이
// Zeroizing<[u8;32]> 임을 컴파일 타임에 강제(이게 아니면 컴파일 실패). 크레이트 경계 밖 스크럽은 비보장.
#[test]
fn kek_is_zeroizing_typed() {
    fn assert_zeroizing(_: &Zeroizing<[u8; KEK_LEN]>) {}
    let kek = get_or_create_kek(&MemoryKeyStore::empty()).expect("create");
    assert_zeroizing(&kek);
}
