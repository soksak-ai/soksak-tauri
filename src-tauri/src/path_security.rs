//! Shared lexical filesystem boundary.
//!
//! Paths are never made safe by canonicalizing through a link. Every existing component is
//! inspected with `symlink_metadata`; links (and Windows reparse points) are rejected in place.

// 심링크·junction 거부 규칙은 코어(pathx)가 소유한다. 여기 사본이 있었고, 사본은 두 답이
// 갈리는 순간까지 조용하다 — 같은 경로에 앱은 거부, 다른 프로세스는 통과가 되고 그 차이는
// 오류가 아니라 "열렸다"로 나타난다. 이름은 그대로 두어 호출자 12곳이 안 바뀐다.
pub(crate) use soksak_core::pathx::reject_symlink_components;


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn physical_temp(name: &str) -> PathBuf {
        let temp = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        temp.join(format!(
            "soksak-path-security-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn parent_segments_are_rejected_lexically() {
        let root = physical_temp("parent");
        let path = root.join("safe").join("..").join("escape");
        assert!(reject_symlink_components(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn existing_and_dangling_symlinks_are_both_rejected() {
        use std::os::unix::fs::symlink;

        let root = physical_temp("links");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("existing-link")).unwrap();
        symlink(root.join("missing"), root.join("dangling-link")).unwrap();

        assert!(reject_symlink_components(&root.join("existing-link").join("child")).is_err());
        assert!(reject_symlink_components(&root.join("dangling-link").join("child")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
