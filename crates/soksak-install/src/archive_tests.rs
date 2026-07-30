use super::*;
use std::fs;
use sha2::{Digest, Sha256};
use std::io::Cursor;

fn tmp_root(name: &str) -> std::path::PathBuf {
    // macOS의 /var는 /private/var symlink다. 제품 경계를 낮추지 않고 fixture만 물리 경로에 둔다.
    let temp = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let d = temp.join(format!("soksak-unpack-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

// dest 내용물(top-level entry) 구조의 canonical tar.gz 바이트 — 테스트도 host tar에 기대지 않는다.
fn make_archive(_root: &std::path::Path) -> Vec<u8> {
    archive_with_raw_entries(&[("mod.dylib", tar::EntryType::Regular, b"fake")])
}

fn sha_of(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{:02x}", x)).collect()
}

fn archive_with_link(entry_type: tar::EntryType) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);

    let target = b"real sidecar bytes";
    let mut target_header = tar::Header::new_gnu();
    target_header.set_size(target.len() as u64);
    target_header.set_mode(0o755);
    target_header.set_entry_type(tar::EntryType::Regular);
    target_header.set_cksum();
    builder
        .append_data(&mut target_header, "real-binary", Cursor::new(target))
        .unwrap();

    let mut link_header = tar::Header::new_gnu();
    link_header.set_size(0);
    link_header.set_mode(0o755);
    link_header.set_entry_type(entry_type);
    link_header.set_link_name("real-binary").unwrap();
    link_header.set_cksum();
    builder
        .append_data(&mut link_header, "mod.dylib", Cursor::new([]))
        .unwrap();

    builder.into_inner().unwrap().finish().unwrap()
}

fn archive_with_raw_entries(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for (path, entry_type, bytes) in entries {
        assert!(
            path.len() < 100,
            "test helper only writes the ustar name field"
        );
        let mut header = tar::Header::new_gnu();
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(*entry_type);
        header.set_cksum();
        builder.append(&header, Cursor::new(*bytes)).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

#[test]
fn sha_mismatch_writes_nothing() {
    let root = tmp_root("sha");
    let body = make_archive(&root);
    let dest = root.join("installed");
    let err = unpack_verify_install(&body, &"0".repeat(64), &dest, "mod.dylib").unwrap_err();
    assert!(err.contains("sha256 불일치"));
    assert!(!dest.exists());
}

#[test]
fn valid_archive_installs_atomically() {
    let root = tmp_root("ok");
    let body = make_archive(&root);
    let dest = root.join("installed");
    unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib").unwrap();
    assert!(dest.join("mod.dylib").is_file());
    // 재설치는 목적지 존재로 거부(멱등 판정은 호출자가 entry 존재로 — sidecar_ensure)
    let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib").unwrap_err();
    assert!(err.contains("이미 존재"));
}

#[test]
fn missing_entry_writes_nothing() {
    let root = tmp_root("entry");
    let body = make_archive(&root);
    let dest = root.join("installed");
    let err = unpack_verify_install(&body, &sha_of(&body), &dest, "other.dylib").unwrap_err();
    assert!(err.contains("entry 없음"));
    assert!(!dest.exists());
}

#[test]
fn symlink_entry_is_rejected_without_installing_anything() {
    let root = tmp_root("symlink-entry");
    let body = archive_with_link(tar::EntryType::Symlink);
    let dest = root.join("installed");
    let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
        .expect_err("archive symlink must never become an installed sidecar");
    assert!(err.contains("symlink") || err.contains("링크"), "{err}");
    assert!(!dest.exists());
}

#[test]
fn hardlink_entry_is_rejected_without_installing_anything() {
    let root = tmp_root("hardlink-entry");
    let body = archive_with_link(tar::EntryType::Link);
    let dest = root.join("installed");
    let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
        .expect_err("archive hardlink must never become an installed sidecar");
    assert!(err.contains("hardlink") || err.contains("링크"), "{err}");
    assert!(!dest.exists());
}

#[test]
fn digest_pin_must_be_exact_lowercase_sha256() {
    let root = tmp_root("sha-shape");
    let body = make_archive(&root);
    for invalid in [
        "deadbeef".to_string(),
        "A".repeat(64),
        format!("{} ", sha_of(&body)),
    ] {
        let dest = root.join(format!("installed-{}", invalid.len()));
        let err = unpack_verify_install(&body, &invalid, &dest, "mod.dylib")
            .expect_err("non-canonical digest pin must be rejected before installation");
        assert!(err.contains("sha256"), "{err}");
        assert!(!dest.exists());
    }
}

#[test]
fn traversal_absolute_and_non_regular_paths_are_rejected() {
    for (name, path, entry_type) in [
        ("parent", "../escape", tar::EntryType::Regular),
        ("absolute", "/absolute", tar::EntryType::Regular),
    ] {
        let root = tmp_root(name);
        let body = archive_with_raw_entries(&[(path, entry_type, b"x")]);
        let dest = root.join("installed");
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, path)
            .expect_err("unsafe/non-regular archive entry must be rejected");
        assert!(
            err.contains("archive path")
                || err.contains("segment")
                || err.contains("non-regular"),
            "{err}"
        );
        assert!(!dest.exists());
        assert!(!root.join("escape").exists());
    }
}

#[test]
fn directory_entries_are_structural_and_skipped() {
    // 관례적 tar 는 디렉토리 엔트리를 싣는다 — 내용이 아니므로 건너뛰고 설치는 성공한다.
    let root = tmp_root("dir-skip");
    let body = archive_with_raw_entries(&[
        ("./", tar::EntryType::Directory, b""),
        ("./bin", tar::EntryType::Directory, b""),
        ("./bin/tool", tar::EntryType::Regular, b"x"),
    ]);
    let dest = root.join("installed");
    unpack_verify_install(&body, &sha_of(&body), &dest, "bin/tool")
        .expect("directory entries must not fail a lawful archive");
    assert!(dest.join("bin/tool").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn duplicate_and_case_colliding_paths_are_rejected() {
    for (name, second) in [("duplicate", "mod.dylib"), ("case", "MOD.DYLIB")] {
        let root = tmp_root(name);
        let body = archive_with_raw_entries(&[
            ("mod.dylib", tar::EntryType::Regular, b"one"),
            (second, tar::EntryType::Regular, b"two"),
        ]);
        let dest = root.join("installed");
        let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
            .expect_err("portable path collision must reject the whole archive");
        assert!(err.contains("collision") || err.contains("중복"), "{err}");
        assert!(!dest.exists());
    }
}

#[cfg(unix)]
#[test]
fn destination_with_symlink_ancestor_is_rejected() {
    use std::os::unix::fs::symlink;

    let root = tmp_root("destination-symlink");
    let physical = root.join("physical");
    let linked = root.join("linked");
    fs::create_dir_all(&physical).unwrap();
    symlink(&physical, &linked).unwrap();
    let body = archive_with_raw_entries(&[("mod.dylib", tar::EntryType::Regular, b"sidecar")]);
    let dest = linked.join("installed");
    let err = unpack_verify_install(&body, &sha_of(&body), &dest, "mod.dylib")
        .expect_err("destination symlink ancestor must not be canonicalized through");
    assert!(err.contains("symlink") || err.contains("junction"), "{err}");
    assert!(!physical.join("installed").exists());
}
