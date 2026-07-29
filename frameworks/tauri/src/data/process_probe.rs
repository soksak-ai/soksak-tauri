// 이 프로세스의 메모리 형편 — 저장소가 아프다는 신호와 프로세스가 굶었다는 신호를 가른다.
//
// 저장소 규칙(soksak_store::integrity)은 이것을 **인자로 받는다**. 여기서 캐면 그 규칙이
// "이 프로세스가 무엇인가"에 의존하게 되고, 같은 코드가 프로세스마다 다른 답을 낸다 — 조용히.

/// 프로세스가 정말 메모리를 못 받는가 — 한도와 실제 할당 가능 여부를 그 순간에 확인한다.
///
/// SQLite 의 `out of memory` 는 저장소가 아파서일 수도, 프로세스가 굶어서일 수도 있다. 그 둘은 사후에
/// 구분할 수 없다(파일은 밖에서 열면 멀쩡하고, 프로세스는 이미 사라졌다). 그래서 실패한 자리에서
/// 직접 재 본다: 한도가 걸려 있는가, 지금 64MiB 를 받을 수 있는가.
pub(crate) fn process_memory_probe() -> String {
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
