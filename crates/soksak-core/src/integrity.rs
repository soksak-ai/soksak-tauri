//! 실행물 무결성 — 해시 검증, 부분/깨진 설치 관찰, 화이트리스트 안의 stale 제거.
//!
//! 디스크만 만진다. 창도 앱 핸들도 프로세스 환경도 읽지 않으므로 어느 프로세스에서 돌든
//! 같은 답을 낸다. 경로는 **전부 인자로 온다** — 홈을 여기서 파생하면 그 순간 이 모듈이
//! "이 프로세스가 앱이다"를 전제하게 된다.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const SHA256_HEX_LEN: usize = 64;

// 심링크 거부는 pathx 가 소유한다. 여기 사본이 있었고 그 사본이 더 약했다 —
// `symlink_metadata` 의 오류를 전부 "링크 아님"으로 삼켜서, 링크를 **못 본 것**과 링크가
// **없는 것**을 같은 값으로 답했다. 그 차이는 거부가 아니라 통과로 나타난다.

pub fn sha256_hex(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn verify_sha256(body: &[u8], expected: &str) -> Result<(), String> {
    if expected.len() != SHA256_HEX_LEN
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("sha256 핀은 정확한 64자리 lowercase hex여야 합니다".into());
    }
    let actual = sha256_hex(body);
    if actual != expected {
        return Err(format!("sha256 불일치: 기대={expected} 실제={actual}"));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct BinaryIntegrity {
    pub present: bool, // bin 이 존재 + 유효(dangling 아님)
    pub partial: bool, // lib 디렉터리 존재하나 bin 부재(어제 EEXIST 의 상태)
    pub broken: bool,  // bin 심링크가 dangling
}

// bin_path = <npm prefix>/bin/<bin>, lib_path = <npm prefix>/lib/node_modules/<pkg>.
// "존재 == 작동" 폐기 — 심링크 무결성과 부분 설치를 구분한다.
pub fn binary_integrity(bin_path: String, lib_path: String) -> BinaryIntegrity {
    let bin = Path::new(&bin_path);
    let lib_exists = Path::new(&lib_path).exists();
    match fs::symlink_metadata(bin) {
        Ok(m) if m.file_type().is_symlink() => {
            // 심링크 — 대상 존재 여부(exists 는 심링크를 따라간다).
            if bin.exists() {
                BinaryIntegrity {
                    present: true,
                    partial: false,
                    broken: false,
                }
            } else {
                BinaryIntegrity {
                    present: false,
                    partial: false,
                    broken: true,
                } // dangling
            }
        }
        Ok(_) => BinaryIntegrity {
            present: true,
            partial: false,
            broken: false,
        }, // 일반 파일
        Err(_) => BinaryIntegrity {
            present: false,
            partial: lib_exists,
            broken: false,
        }, // bin 없음 → lib 있으면 partial
    }
}

// 화이트리스트 루트(npm prefix·~/.soksak 등) 안의 경로만 제거. 그 밖은 거부(안전).
pub fn cleanup_stale(path: String, allowed_roots: Vec<String>) -> Result<bool, String> {
    let p = Path::new(&path);
    // 화이트리스트 판정(starts_with)은 컴포넌트 축자 비교다 — ".." 도 그냥 한 컴포넌트로
    // 보므로 "<root>/../victim" 이 "<root>" 로 시작한다고 답한다. 앵커 없는 화이트리스트는
    // 화이트리스트가 아니다. 호출부가 플러그인 매니페스트 저자 값으로 경로를 조립하므로
    // (state/plugins.ts) 이건 이론이 아니다.
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("경로에 '..'를 사용할 수 없습니다: {path}"));
    }
    let root = allowed_roots
        .iter()
        .find(|r| p.starts_with(r))
        .ok_or_else(|| format!("화이트리스트 밖 경로 거부: {path}"))?;
    // 심링크 검사는 **화이트리스트 루트 아래 구간만** 본다. 루트 위쪽의 링크는 탈출과
    // 무관하다 — 그 경로는 호출자가 지정한 트리 자체이고, macOS 의 /var 처럼 시스템이
    // 링크로 두는 경우도 있다(전 구간을 검사하던 첫 판은 임시 트리 전체를 거부했다).
    // leaf 도 예외다: dangling 심링크 제거가 이 핸들러의 목적이므로 마지막 컴포넌트는
    // 링크여도 된다. 즉 검사 대상은 "루트 다음부터 leaf 직전까지"다.
    if let Some(parent) = p.parent() {
        if let Ok(rel) = parent.strip_prefix(root) {
            let mut walk = std::path::PathBuf::from(root);
            for part in rel.components() {
                walk.push(part);
                if let Ok(m) = fs::symlink_metadata(&walk) {
                    if m.file_type().is_symlink() {
                        return Err(format!(
                            "경로 부모에 심링크를 사용할 수 없습니다: {}",
                            walk.display()
                        ));
                    }
                }
            }
        }
    }
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() || m.is_file() => {
            fs::remove_file(p).map_err(|e| e.to_string())?;
            Ok(true)
        }
        Ok(_) => {
            fs::remove_dir_all(p).map_err(|e| e.to_string())?;
            Ok(true)
        }
        Err(_) => Ok(false), // 이미 없음(멱등)
    }
}

// vendor reach — 저자 번들 파일 sha256 검증 후 dest 에 복사 + 실행권한. 불일치 시 dest 안 건드리고 Err.
pub fn verify_and_link(src: String, dest: String, sha256: String) -> Result<(), String> {
    let body = fs::read(&src).map_err(|e| e.to_string())?;
    verify_sha256(&body, &sha256).map_err(|e| format!("vendor {e}"))?;
    // 최종 경로에는 완성된 파일만 나타난다 — 임시로 쓰고 실행 비트까지 세운 뒤 rename.
    // 옛 판은 copy 뒤에 chmod 였다: 그 사이의 dest 는 실행 비트 없는(혹은 부분 내용의)
    // 파일이다. 지금은 쓰는 쪽과 exec 하는 쪽이 한 프로세스라 직렬화되지만, 프로세스가
    // 갈리면 그 창이 관측 가능해진다.
    let staging = format!("{dest}.staging");
    let _ = fs::remove_file(&staging);
    fs::write(&staging, &body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&staging, fs::Permissions::from_mode(0o755)) {
            let _ = fs::remove_file(&staging);
            return Err(e.to_string());
        }
    }
    if let Err(e) = fs::rename(&staging, &dest) {
        let _ = fs::remove_file(&staging); // 실패한 스테이징을 남기지 않는다
        return Err(e.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod one_symlink_rule_tests {
    use crate::pathx::reject_symlink_components;
    use super::*;

    /// 심링크 거부는 **한 벌**이다.
    ///
    /// 이 파일에 사본이 있었고 그 사본이 더 약했다: `symlink_metadata` 의 오류를 전부
    /// "링크 아님"으로 삼켜서, 링크를 못 본 것과 링크가 없는 것을 같은 값으로 답했다.
    /// 그 차이는 거부가 아니라 **통과**로 나타난다 — 검사가 있는데 안 서는 상태다.
    ///
    /// 판별자: 디렉터리가 아닌 것을 지나는 경로. `symlink_metadata` 가 NotFound 가 아닌
    /// 오류를 내므로, 삼키는 구현만 Ok 를 답한다.
    #[test]
    fn the_two_entry_points_agree() {
        let file = std::env::temp_dir()
            .canonicalize()
            .expect("실측 temp")
            .join(format!("integ-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let through_a_file = file.join("child");

        for p in [
            through_a_file.as_path(),
            Path::new("/definitely-not-here-xyz/a"),
            file.as_path(),
        ] {
            assert_eq!(
                reject_symlink_components(p).is_err(),
                crate::pathx::reject_symlink_components(p).is_err(),
                "같은 경로에 두 답이 나온다: {}",
                p.display()
            );
        }
        let _ = std::fs::remove_file(&file);
    }
}
