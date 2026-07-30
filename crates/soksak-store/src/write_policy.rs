// 쓰기 정책 — 압박을 견디고, 끝내 안 되면 그 순간의 증거와 함께 실패한다.
//
// 저장소의 것이지 프레임워크의 것이 아니다. 껍데기에 두면 같은 이름이 어느 프로세스가
// 답하느냐에 따라 다르게 쓴다: 한쪽은 네 번 견디고 다른 쪽은 첫 실패에 사용자의 저장을
// 버린다. 그 차이는 오류가 아니라 **잃어버린 데이터**로 나타난다.

// 이 프로세스의 메모리 형편 — 저장소가 아프다는 신호와 프로세스가 굶었다는 신호를 가른다.
//
// 저장소 규칙(soksak_store::integrity)은 이것을 **인자로 받는다**. 여기서 캐면 그 규칙이
// "이 프로세스가 무엇인가"에 의존하게 되고, 같은 코드가 프로세스마다 다른 답을 낸다 — 조용히.

/// 프로세스가 정말 메모리를 못 받는가 — 한도와 실제 할당 가능 여부를 그 순간에 확인한다.
///
/// SQLite 의 `out of memory` 는 저장소가 아파서일 수도, 프로세스가 굶어서일 수도 있다. 그 둘은 사후에
/// 구분할 수 없다(파일은 밖에서 열면 멀쩡하고, 프로세스는 이미 사라졌다). 그래서 실패한 자리에서
/// 직접 재 본다: 한도가 걸려 있는가, 지금 64MiB 를 받을 수 있는가.
pub fn process_memory_probe() -> String {
    let lim = |res: libc::c_int| -> String {
        let mut rl = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::getrlimit(res, &mut rl) } == 0 {
            if rl.rlim_cur == libc::RLIM_INFINITY {
                "무제한".to_string()
            } else {
                format!("{}B", rl.rlim_cur)
            }
        } else {
            "?".to_string()
        }
    };
    // 64MiB 시험 할당 — 성공하면 프로세스는 굶지 않은 것이고, 그 `out of memory` 는 저장소 쪽 신호다.
    const PROBE: usize = 64 * 1024 * 1024;
    let got = {
        let p = unsafe { libc::malloc(PROBE) };
        if p.is_null() {
            false
        } else {
            unsafe { libc::free(p) };
            true
        }
    };
    format!(
        "프로세스 한도 DATA {} AS {} | 64MiB 시험할당 {}",
        lim(libc::RLIMIT_DATA),
        lim(libc::RLIMIT_AS),
        if got { "성공" } else { "실패" }
    )
}

// 쓰기 = 압박을 견디고, 끝내 안 되면 증거와 함께 실패한다. 기계가 바쁜 몇 초 때문에 사용자의
// 저장을 버리지 않는다(integrity.rs with_nomem_retry 머리말). 되돌려진 트랜잭션을 다시 여는
// 것이라 안전하다.
const WRITE_ATTEMPTS: u32 = 4;
const WRITE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(60);

// 물리 이상이 의심되는 쓰기 실패에 그 순간의 증거를 붙인다. SQLite 가 `out of memory` 를
// 돌려주는 쓰기는 메모리가 없어서가 아니라 저장소가 아파서일 수 있고(integrity.rs 머리말),
// 그 구분은 실패한 그 순간에만 가능하다 — 사후에 파일을 밖에서 열면 멀쩡해 보인다(실측).
// 그 외 실패는 그대로 둔다.
fn with_evidence(conn: &rusqlite::Connection, err: String) -> String {
    if !err.contains("out of memory") {
        return err;
    }
    format!(
        "{err} [저장소 실황: {}]",
        crate::integrity::failure_evidence(conn, &process_memory_probe())
    )
}

/// 쓰기 하나 — 압박을 견디고, 끝내 안 되면 증거와 함께 실패한다.
pub fn write_with_retry<T>(
    conn: &rusqlite::Connection,
    op: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    crate::integrity::with_nomem_retry(WRITE_ATTEMPTS, WRITE_BACKOFF, op)
        .map_err(|e| with_evidence(conn, e))
}
