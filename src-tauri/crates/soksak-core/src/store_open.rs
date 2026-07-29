// 저장소를 **어떻게 여는가** — 연결은 자원이지만, 여는 규칙은 프로세스의 것이 아니다.
//
// 같은 파일을 두 프로세스가 각자의 규칙으로 열면 그 차이는 오류로 나타나지 않는다. **데이터의
// 성질**로 나타난다. 그리고 두 가지는 파일이 태어날 때 한 번 정해지고 이후에 바꿔도 무시된다:
//
//   auto_vacuum=INCREMENTAL — 첫 CREATE 전에만 먹는다. NONE 으로 태어난 저장소에서는 retention
//     의 incremental_vacuum 이 조용히 0 페이지를 돌려준다("지웠는데 파일이 안 준다").
//   secure_delete=ON — 지운 셀을 0 으로 채운다. OFF 로 태어나면 봉인 전환(in-place UPDATE)이
//     남긴 옛 평문 셀과 FTS 텀이 freelist·WAL 에 잔존해 키 없이 파일에서 긁힌다. 봉인 데이터의
//     at-rest 전제가 거기서 깨진다.
//
// 실측(2026-07-29): 앱이 없는 홈에서는 cored 가 저장소를 처음 만든다. 그 자리가 맨 연결이라
// 이 프레임워크의 홈은 전부 auto_vacuum=NONE·secure_delete=OFF 로 태어났다. 오류는 없었다.
//
// rusqlite 타입은 여기 오지 않는다(kv 머리말과 같은 이유) — 문장만 소유하고, 실행은 연결을
// 쥔 쪽이 한다. 그래야 앱도 cored 도 같은 규칙을 통과한다.

/// 저장소를 열자마자 거는 PRAGMA — **순서가 계약이다.**
///
/// auto_vacuum·secure_delete 가 먼저다. 스키마를 만든 뒤에 걸면 둘 다 무시된다.
pub const OPEN_PRAGMA_SQL: &str = "PRAGMA auto_vacuum=INCREMENTAL;\
     PRAGMA secure_delete=ON;\
     PRAGMA journal_mode=WAL;\
     PRAGMA synchronous=NORMAL;\
     PRAGMA busy_timeout=5000;\
     PRAGMA foreign_keys=ON;\
     PRAGMA temp_store=MEMORY;";

/// 저장소 파일의 권한 — 봉투 키와 레코드가 사는 파일이다.
///
/// 같은 머신의 다른 사용자에게 열어 두지 않는다(소켓 0600 과 같은 선례). 권한을 지원하지 않는
/// 파일 시스템에서는 거는 쪽이 조용히 넘어간다 — 못 거는 것과 안 거는 것은 다르다.
pub const STORE_FILE_MODE: u32 = 0o600;

#[cfg(test)]
mod tests {
    use super::*;

    /// 순서가 계약이다 — 스키마 뒤에 걸면 무시되는 둘이 맨 앞에 온다.
    #[test]
    fn the_born_once_pragmas_come_first() {
        let head = OPEN_PRAGMA_SQL
            .split(';')
            .take(2)
            .map(str::trim)
            .collect::<Vec<_>>();
        assert_eq!(
            head,
            vec!["PRAGMA auto_vacuum=INCREMENTAL", "PRAGMA secure_delete=ON"]
        );
    }

    /// 한 줄이라도 빠지면 그 홈의 저장소만 다른 성질을 갖는다 — 전수로 고정한다.
    #[test]
    fn every_pragma_is_named() {
        for want in [
            "auto_vacuum=INCREMENTAL",
            "secure_delete=ON",
            "journal_mode=WAL",
            "synchronous=NORMAL",
            "busy_timeout=5000",
            "foreign_keys=ON",
            "temp_store=MEMORY",
        ] {
            assert!(OPEN_PRAGMA_SQL.contains(want), "{want} 이 빠졌다");
        }
    }

    #[test]
    fn the_store_file_is_private() {
        assert_eq!(STORE_FILE_MODE, 0o600);
    }
}
