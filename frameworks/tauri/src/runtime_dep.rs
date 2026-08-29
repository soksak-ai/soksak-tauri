// runtime_dep — 외부 런타임 의존성(4-tuple)의 IO 경계. TS 순수 결정(runtimeDep.ts)이 못 하는 디스크/네트워크:
//   binary_integrity: present/partial/broken 정밀 관찰(심링크 dangling·부분 설치 = 어제 EEXIST).
//   cleanup_stale:    화이트리스트 경로 안의 stale 만 안전 제거(PARTIAL/BROKEN reconcile 의 cleanup).
//   download_verify:  fetch reach — url 다운로드 후 sha256 무결성 검증 + 실행권한.
// 아래 여섯은 soksak-core 로 옮겼다 — 이 파일에는 프레임워크 진입점(무논리 위임)만 남는다.
// `#[tauri::command]` 속성 자체가 tauri 의존이라 코어 크레이트가 가질 수 없다.
pub(crate) use soksak_core::artifact_integrity::verify_sha256;
#[cfg(test)]
use soksak_core::artifact_integrity::sha256_hex;
pub use soksak_core::artifact_integrity::BinaryIntegrity;

#[tauri::command]
pub fn binary_integrity(bin_path: String, lib_path: String) -> BinaryIntegrity {
    soksak_core::artifact_integrity::binary_integrity(bin_path, lib_path)
}

#[tauri::command]
pub fn cleanup_stale(path: String, allowed_roots: Vec<String>) -> Result<bool, String> {
    soksak_core::artifact_integrity::cleanup_stale(path, allowed_roots)
}

#[tauri::command]
pub fn verify_and_link(src: String, dest: String, sha256: String) -> Result<(), String> {
    soksak_core::artifact_integrity::verify_and_link(src, dest, sha256)
}

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const SHA256_HEX_LEN: usize = 64;





pub use soksak_core::probe::ProbeResult;

#[tauri::command]
pub fn probe_binary(bin: String, args: Vec<String>) -> ProbeResult {
    soksak_core::probe::probe_binary(bin, args)
}


// fetch reach — url 다운로드 후 sha256 검증. 불일치/실패 시 dest 를 쓰지 않고 Err(무결성 우선).
#[tauri::command]
pub fn download_verify(url: String, dest: String, sha256: String) -> Result<(), String> {
    // 판정과 쓰기는 코어가 진다 — cored 도 같은 함수를 부른다. 여기 사본을 두면 두 프로세스가
    // 같은 이름에 다른 규칙을 갖고, 그 차이는 오류가 아니라 **다른 파일**로 나타난다.
    let body = soksak_net::transport::honest_get_bytes(&url)?;
    soksak_core::artifact_integrity::verify_and_write(&body, &sha256, std::path::Path::new(&dest))
}

#[derive(serde::Serialize)]
pub struct NpmDirs {
    pub bin_dir: String,
    pub lib_dir: String,
}

// npm 글로벌 prefix → bin/lib 디렉터리(binary_integrity 의 경로 계산용). 로그인 셸로 PATH 보존.
#[tauri::command]
pub fn npm_global_dirs() -> Result<NpmDirs, String> {
    let shell = crate::login_shell::ambient();
    let (prog, args) = soksak_core::shellq::npm_prefix_argv(&shell);
    let out = std::process::Command::new(prog)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let (bin_dir, lib_dir) =
        soksak_core::shellq::npm_dirs_from_prefix(&String::from_utf8_lossy(&out.stdout))?;
    Ok(NpmDirs { bin_dir, lib_dir })
}


#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::symlink;

    /// 테스트마다 자기 디렉터리를 쓴다 — 프로세스 단위로 공유하면 병렬 실행 중 한 테스트의
    /// remove_dir_all 이 다른 테스트가 방금 만든 트리를 지운다(실측: 모듈 단독은 통과하는데
    /// 전체 스위트에서만 NotFound 로 깨졌다). 이름은 호출자가 준다.
    fn tmp_named(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rtdep-{}-{name}", std::process::id()));
        let _ = fs::create_dir_all(&d);
        d
    }

    // 화이트리스트가 경로를 앵커하지 못하면 삭제 프리미티브가 트리 밖으로 나간다.
    // Path::starts_with 는 컴포넌트 축자 비교라 ".." 를 그냥 한 컴포넌트로 본다 —
    // "<root>/../victim" 이 "<root>" 로 시작한다고 판정된다. 호출부가 플러그인 매니페스트
    // 저자 값으로 경로를 조립하므로(state/plugins.ts) 이건 이론이 아니다.
    #[test]
    fn parent_escape_is_refused_and_nothing_is_removed() {
        let d = tmp_named("parent_escape_is").join("escape");
        let root = d.join("root");
        let victim = d.join("victim.txt");
        let _ = fs::create_dir_all(&root);
        fs::write(&victim, b"keep").unwrap();
        let escape = root.join("..").join("victim.txt");
        let r = cleanup_stale(
            escape.to_string_lossy().into(),
            vec![root.to_string_lossy().into()],
        );
        assert!(r.is_err(), "'..' 로 트리를 벗어난 경로가 통과했다: {r:?}");
        assert!(victim.exists(), "거부됐다면서 지워졌다");
        let _ = fs::remove_dir_all(&d);
    }

    // 부모가 심링크면 화이트리스트 판정은 링크 **밖**의 실체를 보지 못한다.
    // (leaf 의 심링크는 허용해야 한다 — 이 핸들러의 목적이 dangling 심링크 제거다.)
    #[test]
    fn a_symlinked_parent_is_refused_but_a_symlinked_leaf_is_not() {
        let d = tmp_named("a_symlinked_pare").join("linkparent");
        let real = d.join("real");
        let root = d.join("root");
        let _ = fs::create_dir_all(&real);
        let _ = fs::create_dir_all(&root);
        let victim = real.join("victim.txt");
        fs::write(&victim, b"keep").unwrap();
        let link = root.join("via");
        let _ = fs::remove_file(&link);
        symlink(&real, &link).unwrap();
        let through = link.join("victim.txt");
        let r = cleanup_stale(
            through.to_string_lossy().into(),
            vec![root.to_string_lossy().into()],
        );
        assert!(r.is_err(), "심링크 부모를 통과했다: {r:?}");
        assert!(victim.exists(), "거부됐다면서 지워졌다");

        // leaf 심링크(dangling)는 이 핸들러가 지워야 하는 바로 그것이다.
        let dangling = root.join("dangling");
        let _ = fs::remove_file(&dangling);
        symlink(root.join("nope"), &dangling).unwrap();
        let r = cleanup_stale(
            dangling.to_string_lossy().into(),
            vec![root.to_string_lossy().into()],
        );
        assert_eq!(r, Ok(true), "leaf 심링크 제거는 이 핸들러의 목적이다");
        let _ = fs::remove_dir_all(&d);
    }

    // 가드(재현 아님) — 단일 프로세스에서는 옛 비원자 판도 이 단언을 통과한다. 창이
    // 프로세스 경계에서만 관측되기 때문이다. 그래도 남긴다: 스테이징 잔여물과 내용·권한을
    // 고정해 두면 원자 쓰기를 되돌리는 변경이 여기서 걸린다.
    #[test]
    fn the_destination_never_holds_a_partial_file() {
        let d = tmp_named("the_destination_").join("atomic");
        let _ = fs::create_dir_all(&d);
        let src = d.join("src.bin");
        let dest = d.join("dest.bin");
        fs::write(&src, b"payload").unwrap();
        let sum = sha256_hex(b"payload");
        verify_and_link(
            src.to_string_lossy().into(),
            dest.to_string_lossy().into(),
            sum,
        )
        .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"payload");
        // 임시 잔여물이 남으면 다음 사람이 그것을 실행물로 착각한다.
        let leftovers: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "src.bin" && n != "dest.bin")
            .collect();
        assert_eq!(leftovers, Vec::<String>::new(), "임시 파일이 남았다");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn integrity_absent_partial_broken_present() {
        let d = tmp_named("integrity_absent");
        let bin = d.join("bin-x");
        let lib = d.join("lib-x");
        // ABSENT: 둘 다 없음
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(!r.present && !r.partial && !r.broken);
        // PARTIAL: lib 만 존재
        fs::create_dir_all(&lib).unwrap();
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(r.partial && !r.present);
        // BROKEN: bin 이 dangling 심링크
        let _ = symlink(d.join("nonexistent"), &bin);
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(r.broken && !r.present);
        // PRESENT: 심링크 대상 존재
        let target = d.join("real");
        fs::write(&target, b"x").unwrap();
        let _ = fs::remove_file(&bin);
        let _ = symlink(&target, &bin);
        let r = binary_integrity(bin.to_string_lossy().into(), lib.to_string_lossy().into());
        assert!(r.present && !r.broken && !r.partial);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cleanup_rejects_outside_whitelist() {
        assert!(cleanup_stale("/etc/passwd".into(), vec!["<local-evidence>".into()]).is_err());
    }

    #[test]
    fn probe_reports_exit_and_stdout() {
        // 작동: echo 는 exit 0 + stdout
        let r = probe_binary("echo".into(), vec!["hello".into()]);
        assert!(r.ok && r.stdout.contains("hello"));
        // 존재하나 작동 실패: false 는 exit 1 (present != working)
        let r = probe_binary("false".into(), vec![]);
        assert!(!r.ok);
        // 부재: 없는 bin → 실행 실패 → ok=false
        let r = probe_binary("definitely-no-such-bin-xyz".into(), vec![]);
        assert!(!r.ok);
    }
}
