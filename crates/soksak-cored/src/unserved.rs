//! 감사했으나 서빙하지 않는 이름과 **무엇이 막는가**.
//!
//! 표에 없다는 사실만으로는 "아직 안 옮겼다"와 "여기서는 못 한다"가 구분되지 않는다.
//! 프레임워크 저자가 받는 것은 UNKNOWN_COMMAND 한 줄뿐이라, 사유가 없으면 막힌 것을 다시
//! 조사하거나 더 나쁘게는 조사 없이 흉내를 낸다. 이유 없는 금지는 우회 대상이 된다.
//!
//! **사유가 코드보다 길다.** 그래서 따로 산다 — 서빙하는 표와 한 파일에 두면 그 파일의
//! 길이가 "무엇을 서빙하는가"가 아니라 "무엇을 못 하는지 얼마나 자세히 적었는가"를 따라
//! 자란다. 사유를 자세히 적을수록 파일이 길어져 나눠야 하는 압력이 커지는 것은, 정직하게
//! 적는 일에 벌을 주는 모양이다.

pub struct Unserved {
    pub name: &'static str,
    pub blocked_by: &'static str,
}

/// 옮기려다 막힌 것들. 여기 있는 이름이 표로 올라가려면 사유가 먼저 사라져야 한다.
pub const UNSERVED: &[Unserved] = &[
    Unserved {
        name: "data_stats",
        blocked_by: "저장소의 사실만 답하는 것처럼 보이지만 절반이 **프로세스 전역**이다 — 힙 상한(soft/hard)과 \
                     SQLite 메모리 사용량·최고치는 sqlite3_memory_used/_highwater 로 이 프로세스의 것이고, 부팅 \
                     게이트와 SQLite 자기 로그도 이 프로세스가 설치한 것이다. 이 명령의 목적이 '앱이 무엇에 \
                     굶었는가'라서, cored 가 답하면 cored 의 힙을 답하고 모양이 같아 구분되지 않는다. 옮기려면 \
                     답에 '어느 프로세스의 것인가'를 실어야 하고, 그것은 같은 이름의 다른 계약이다.",
    },
    Unserved {
        name: "data_encrypt_status",
        blocked_by: "봉인 열쇠의 소유가 볼트에 있다. 볼트의 **몸**은 이제 프레임워크 밖 크레이트지만 \
                     (soksak-vault — 창도 앱 핸들도 키체인도 모르고 KEK 는 KekSource 로 주입받는다), 이 \
                     프로세스가 쥔 열쇠 이음매는 SealKeys 하나이고 그 구현은 NoSealKeys 다. 그대로 세우면 \
                     컴파일도 되고 답도 나온다 — unlocked 가 거짓으로 굳어 tampered·key_missing 이 언제나 \
                     거짓이 되고, 열쇠가 바뀐 scope 가 '멀쩡함'과 같은 모양으로 나온다. 조용한 오답이 \
                     오류보다 나쁘다. 열쇠를 **만드는** 쪽(enable·recover·rotate·change_recovery)은 더 멀다: \
                     SealKeys::new_key 는 만들어 보관까지 하지만 비밀키를 돌려주지 않는데, 그쪽은 그 비밀키로 \
                     복구 코드를 발급하고 다시 wrap 한다(data_keys::issue_recovery). 계약을 그 모양으로 넓히는 \
                     것이 먼저고, 이름만 올리면 복구 코드 없는 봉인이 남는다. 열쇠 바이트를 **얻는** 쪽이 \
                     막히는 사유는 형제 secret_* 와 같다.",
    },
    Unserved {
        name: "data_encrypt_enable",
        blocked_by: "봉인 열쇠의 소유가 볼트에 있다. 볼트의 **몸**은 이제 프레임워크 밖 크레이트지만 \
                     (soksak-vault — 창도 앱 핸들도 키체인도 모르고 KEK 는 KekSource 로 주입받는다), 이 \
                     프로세스가 쥔 열쇠 이음매는 SealKeys 하나이고 그 구현은 NoSealKeys 다. 그대로 세우면 \
                     컴파일도 되고 답도 나온다 — unlocked 가 거짓으로 굳어 tampered·key_missing 이 언제나 \
                     거짓이 되고, 열쇠가 바뀐 scope 가 '멀쩡함'과 같은 모양으로 나온다. 조용한 오답이 \
                     오류보다 나쁘다. 열쇠를 **만드는** 쪽(enable·recover·rotate·change_recovery)은 더 멀다: \
                     SealKeys::new_key 는 만들어 보관까지 하지만 비밀키를 돌려주지 않는데, 그쪽은 그 비밀키로 \
                     복구 코드를 발급하고 다시 wrap 한다(data_keys::issue_recovery). 계약을 그 모양으로 넓히는 \
                     것이 먼저고, 이름만 올리면 복구 코드 없는 봉인이 남는다. 열쇠 바이트를 **얻는** 쪽이 \
                     막히는 사유는 형제 secret_* 와 같다.",
    },
    Unserved {
        name: "data_encrypt_recover",
        blocked_by: "봉인 열쇠의 소유가 볼트에 있다. 볼트의 **몸**은 이제 프레임워크 밖 크레이트지만 \
                     (soksak-vault — 창도 앱 핸들도 키체인도 모르고 KEK 는 KekSource 로 주입받는다), 이 \
                     프로세스가 쥔 열쇠 이음매는 SealKeys 하나이고 그 구현은 NoSealKeys 다. 그대로 세우면 \
                     컴파일도 되고 답도 나온다 — unlocked 가 거짓으로 굳어 tampered·key_missing 이 언제나 \
                     거짓이 되고, 열쇠가 바뀐 scope 가 '멀쩡함'과 같은 모양으로 나온다. 조용한 오답이 \
                     오류보다 나쁘다. 열쇠를 **만드는** 쪽(enable·recover·rotate·change_recovery)은 더 멀다: \
                     SealKeys::new_key 는 만들어 보관까지 하지만 비밀키를 돌려주지 않는데, 그쪽은 그 비밀키로 \
                     복구 코드를 발급하고 다시 wrap 한다(data_keys::issue_recovery). 계약을 그 모양으로 넓히는 \
                     것이 먼저고, 이름만 올리면 복구 코드 없는 봉인이 남는다. 열쇠 바이트를 **얻는** 쪽이 \
                     막히는 사유는 형제 secret_* 와 같다.",
    },
    Unserved {
        name: "data_encrypt_rotate",
        blocked_by: "봉인 열쇠의 소유가 볼트에 있다. 볼트의 **몸**은 이제 프레임워크 밖 크레이트지만 \
                     (soksak-vault — 창도 앱 핸들도 키체인도 모르고 KEK 는 KekSource 로 주입받는다), 이 \
                     프로세스가 쥔 열쇠 이음매는 SealKeys 하나이고 그 구현은 NoSealKeys 다. 그대로 세우면 \
                     컴파일도 되고 답도 나온다 — unlocked 가 거짓으로 굳어 tampered·key_missing 이 언제나 \
                     거짓이 되고, 열쇠가 바뀐 scope 가 '멀쩡함'과 같은 모양으로 나온다. 조용한 오답이 \
                     오류보다 나쁘다. 열쇠를 **만드는** 쪽(enable·recover·rotate·change_recovery)은 더 멀다: \
                     SealKeys::new_key 는 만들어 보관까지 하지만 비밀키를 돌려주지 않는데, 그쪽은 그 비밀키로 \
                     복구 코드를 발급하고 다시 wrap 한다(data_keys::issue_recovery). 계약을 그 모양으로 넓히는 \
                     것이 먼저고, 이름만 올리면 복구 코드 없는 봉인이 남는다. 열쇠 바이트를 **얻는** 쪽이 \
                     막히는 사유는 형제 secret_* 와 같다.",
    },
    Unserved {
        name: "data_encrypt_change_recovery",
        blocked_by: "봉인 열쇠의 소유가 볼트에 있다. 볼트의 **몸**은 이제 프레임워크 밖 크레이트지만 \
                     (soksak-vault — 창도 앱 핸들도 키체인도 모르고 KEK 는 KekSource 로 주입받는다), 이 \
                     프로세스가 쥔 열쇠 이음매는 SealKeys 하나이고 그 구현은 NoSealKeys 다. 그대로 세우면 \
                     컴파일도 되고 답도 나온다 — unlocked 가 거짓으로 굳어 tampered·key_missing 이 언제나 \
                     거짓이 되고, 열쇠가 바뀐 scope 가 '멀쩡함'과 같은 모양으로 나온다. 조용한 오답이 \
                     오류보다 나쁘다. 열쇠를 **만드는** 쪽(enable·recover·rotate·change_recovery)은 더 멀다: \
                     SealKeys::new_key 는 만들어 보관까지 하지만 비밀키를 돌려주지 않는데, 그쪽은 그 비밀키로 \
                     복구 코드를 발급하고 다시 wrap 한다(data_keys::issue_recovery). 계약을 그 모양으로 넓히는 \
                     것이 먼저고, 이름만 올리면 복구 코드 없는 봉인이 남는다. 열쇠 바이트를 **얻는** 쪽이 \
                     막히는 사유는 형제 secret_* 와 같다.",
    },
    Unserved {
        name: "secret_set",
        blocked_by: "볼트의 **몸**은 더는 벽이 아니다 — soksak-vault 는 프레임워크 밖 크레이트고 창도 앱 \
                     핸들도 키체인도 모른다. KEK 는 KekSource 로 주입받으므로 이음매도 공개다. 막는 것은 그 \
                     바이트를 **얻는 쪽**이고, 넷이 함께다. ① 유일한 프로덕션 출처가 OS 키체인이고 그 구현이 \
                     keyring 을 탄다 — Windows 피처가 windows-sys 를 끌고 오는데 이 프로세스의 no_framework \
                     게이트가 그 이름을 막는다 ② 키체인 항목이 **앱 신원 ACL** 에 결속된다: 이음매가 공개라도 \
                     바이트를 내주는 상대는 그 신원으로 서명된 실행물뿐이라, 다른 실행물이 물으면 거절이나 \
                     사용자 승인이 나온다 ③ 읽기가 쓰기다 — has/keys 도 ensure_open 을 지나고, 볼트 파일이 \
                     없으면 그 자리에서 KEK 를 만들어 새 볼트를 봉인해 flush 한다. 부팅이 키체인을 건드리지 \
                     않는 규칙(2d06843f)과 정면으로 부딪힌다 ④ 자동생성 거부 깃발(expect_vault, [R23])을 \
                     세우는 것이 앱의 부팅이다. cored 가 자기 상태를 세우면 그 깃발이 거짓이라, 볼트가 사라진 \
                     홈에서 손실 의심 거부가 없어지고 **빈 볼트를 새로 만들며 성공을 답한다.**",
    },
    Unserved {
        name: "secret_has",
        blocked_by: "볼트의 **몸**은 더는 벽이 아니다 — soksak-vault 는 프레임워크 밖 크레이트고 창도 앱 \
                     핸들도 키체인도 모른다. KEK 는 KekSource 로 주입받으므로 이음매도 공개다. 막는 것은 그 \
                     바이트를 **얻는 쪽**이고, 넷이 함께다. ① 유일한 프로덕션 출처가 OS 키체인이고 그 구현이 \
                     keyring 을 탄다 — Windows 피처가 windows-sys 를 끌고 오는데 이 프로세스의 no_framework \
                     게이트가 그 이름을 막는다 ② 키체인 항목이 **앱 신원 ACL** 에 결속된다: 이음매가 공개라도 \
                     바이트를 내주는 상대는 그 신원으로 서명된 실행물뿐이라, 다른 실행물이 물으면 거절이나 \
                     사용자 승인이 나온다 ③ 읽기가 쓰기다 — has/keys 도 ensure_open 을 지나고, 볼트 파일이 \
                     없으면 그 자리에서 KEK 를 만들어 새 볼트를 봉인해 flush 한다. 부팅이 키체인을 건드리지 \
                     않는 규칙(2d06843f)과 정면으로 부딪힌다 ④ 자동생성 거부 깃발(expect_vault, [R23])을 \
                     세우는 것이 앱의 부팅이다. cored 가 자기 상태를 세우면 그 깃발이 거짓이라, 볼트가 사라진 \
                     홈에서 손실 의심 거부가 없어지고 **빈 볼트를 새로 만들며 성공을 답한다.**",
    },
    Unserved {
        name: "secret_delete",
        blocked_by: "볼트의 **몸**은 더는 벽이 아니다 — soksak-vault 는 프레임워크 밖 크레이트고 창도 앱 \
                     핸들도 키체인도 모른다. KEK 는 KekSource 로 주입받으므로 이음매도 공개다. 막는 것은 그 \
                     바이트를 **얻는 쪽**이고, 넷이 함께다. ① 유일한 프로덕션 출처가 OS 키체인이고 그 구현이 \
                     keyring 을 탄다 — Windows 피처가 windows-sys 를 끌고 오는데 이 프로세스의 no_framework \
                     게이트가 그 이름을 막는다 ② 키체인 항목이 **앱 신원 ACL** 에 결속된다: 이음매가 공개라도 \
                     바이트를 내주는 상대는 그 신원으로 서명된 실행물뿐이라, 다른 실행물이 물으면 거절이나 \
                     사용자 승인이 나온다 ③ 읽기가 쓰기다 — has/keys 도 ensure_open 을 지나고, 볼트 파일이 \
                     없으면 그 자리에서 KEK 를 만들어 새 볼트를 봉인해 flush 한다. 부팅이 키체인을 건드리지 \
                     않는 규칙(2d06843f)과 정면으로 부딪힌다 ④ 자동생성 거부 깃발(expect_vault, [R23])을 \
                     세우는 것이 앱의 부팅이다. cored 가 자기 상태를 세우면 그 깃발이 거짓이라, 볼트가 사라진 \
                     홈에서 손실 의심 거부가 없어지고 **빈 볼트를 새로 만들며 성공을 답한다.**",
    },
    Unserved {
        name: "secret_keys",
        blocked_by: "볼트의 **몸**은 더는 벽이 아니다 — soksak-vault 는 프레임워크 밖 크레이트고 창도 앱 \
                     핸들도 키체인도 모른다. KEK 는 KekSource 로 주입받으므로 이음매도 공개다. 막는 것은 그 \
                     바이트를 **얻는 쪽**이고, 넷이 함께다. ① 유일한 프로덕션 출처가 OS 키체인이고 그 구현이 \
                     keyring 을 탄다 — Windows 피처가 windows-sys 를 끌고 오는데 이 프로세스의 no_framework \
                     게이트가 그 이름을 막는다 ② 키체인 항목이 **앱 신원 ACL** 에 결속된다: 이음매가 공개라도 \
                     바이트를 내주는 상대는 그 신원으로 서명된 실행물뿐이라, 다른 실행물이 물으면 거절이나 \
                     사용자 승인이 나온다 ③ 읽기가 쓰기다 — has/keys 도 ensure_open 을 지나고, 볼트 파일이 \
                     없으면 그 자리에서 KEK 를 만들어 새 볼트를 봉인해 flush 한다. 부팅이 키체인을 건드리지 \
                     않는 규칙(2d06843f)과 정면으로 부딪힌다 ④ 자동생성 거부 깃발(expect_vault, [R23])을 \
                     세우는 것이 앱의 부팅이다. cored 가 자기 상태를 세우면 그 깃발이 거짓이라, 볼트가 사라진 \
                     홈에서 손실 의심 거부가 없어지고 **빈 볼트를 새로 만들며 성공을 답한다.**",
    },
    Unserved {
        name: "secret_backend",
        blocked_by: "볼트의 **몸**은 더는 벽이 아니다 — soksak-vault 는 프레임워크 밖 크레이트고 창도 앱 \
                     핸들도 키체인도 모른다. KEK 는 KekSource 로 주입받으므로 이음매도 공개다. 막는 것은 그 \
                     바이트를 **얻는 쪽**이고, 넷이 함께다. ① 유일한 프로덕션 출처가 OS 키체인이고 그 구현이 \
                     keyring 을 탄다 — Windows 피처가 windows-sys 를 끌고 오는데 이 프로세스의 no_framework \
                     게이트가 그 이름을 막는다 ② 키체인 항목이 **앱 신원 ACL** 에 결속된다: 이음매가 공개라도 \
                     바이트를 내주는 상대는 그 신원으로 서명된 실행물뿐이라, 다른 실행물이 물으면 거절이나 \
                     사용자 승인이 나온다 ③ 읽기가 쓰기다 — has/keys 도 ensure_open 을 지나고, 볼트 파일이 \
                     없으면 그 자리에서 KEK 를 만들어 새 볼트를 봉인해 flush 한다. 부팅이 키체인을 건드리지 \
                     않는 규칙(2d06843f)과 정면으로 부딪힌다 ④ 자동생성 거부 깃발(expect_vault, [R23])을 \
                     세우는 것이 앱의 부팅이다. cored 가 자기 상태를 세우면 그 깃발이 거짓이라, 볼트가 사라진 \
                     홈에서 손실 의심 거부가 없어지고 **빈 볼트를 새로 만들며 성공을 답한다.**",
    },
    Unserved {
        name: "unit_install_begin",
        blocked_by: "디스크 스테이징이라 자원처럼 보이지만 넷이 막는다. ① stage 가 받아오는 경로가 런타임을 \
                     끌고 온다(게이트가 런타임을 이름으로 막는다) ② 매니저 **생성자가 파괴적**이다 — 만드는 \
                     순간 스테이징 디렉터리를 통째로 비우고, 앱은 그것을 부팅마다 만든다. 두 프로세스가 각자 \
                     만들면 남의 트랜잭션이 명령 이전에 사라진다 ③ commit 이 쓰는 플러그인 디렉터리에는 쓰기 \
                     소유권 표가 없다(같은 사유로 plugin_install_git 이 이미 여기 있다) ④ 원장이 프로세스 \
                     메모리라 begin 과 commit 을 다른 프로세스가 잡으면 뒤쪽은 100% 실패 경로만 남는다.",
    },
    Unserved {
        name: "unit_install_stage",
        blocked_by: "디스크 스테이징이라 자원처럼 보이지만 넷이 막는다. ① stage 가 받아오는 경로가 런타임을 \
                     끌고 온다(게이트가 런타임을 이름으로 막는다) ② 매니저 **생성자가 파괴적**이다 — 만드는 \
                     순간 스테이징 디렉터리를 통째로 비우고, 앱은 그것을 부팅마다 만든다. 두 프로세스가 각자 \
                     만들면 남의 트랜잭션이 명령 이전에 사라진다 ③ commit 이 쓰는 플러그인 디렉터리에는 쓰기 \
                     소유권 표가 없다(같은 사유로 plugin_install_git 이 이미 여기 있다) ④ 원장이 프로세스 \
                     메모리라 begin 과 commit 을 다른 프로세스가 잡으면 뒤쪽은 100% 실패 경로만 남는다.",
    },
    Unserved {
        name: "unit_install_commit",
        blocked_by: "디스크 스테이징이라 자원처럼 보이지만 넷이 막는다. ① stage 가 받아오는 경로가 런타임을 \
                     끌고 온다(게이트가 런타임을 이름으로 막는다) ② 매니저 **생성자가 파괴적**이다 — 만드는 \
                     순간 스테이징 디렉터리를 통째로 비우고, 앱은 그것을 부팅마다 만든다. 두 프로세스가 각자 \
                     만들면 남의 트랜잭션이 명령 이전에 사라진다 ③ commit 이 쓰는 플러그인 디렉터리에는 쓰기 \
                     소유권 표가 없다(같은 사유로 plugin_install_git 이 이미 여기 있다) ④ 원장이 프로세스 \
                     메모리라 begin 과 commit 을 다른 프로세스가 잡으면 뒤쪽은 100% 실패 경로만 남는다.",
    },
    Unserved {
        name: "unit_install_rollback",
        blocked_by: "디스크 스테이징이라 자원처럼 보이지만 넷이 막는다. ① stage 가 받아오는 경로가 런타임을 \
                     끌고 온다(게이트가 런타임을 이름으로 막는다) ② 매니저 **생성자가 파괴적**이다 — 만드는 \
                     순간 스테이징 디렉터리를 통째로 비우고, 앱은 그것을 부팅마다 만든다. 두 프로세스가 각자 \
                     만들면 남의 트랜잭션이 명령 이전에 사라진다 ③ commit 이 쓰는 플러그인 디렉터리에는 쓰기 \
                     소유권 표가 없다(같은 사유로 plugin_install_git 이 이미 여기 있다) ④ 원장이 프로세스 \
                     메모리라 begin 과 commit 을 다른 프로세스가 잡으면 뒤쪽은 100% 실패 경로만 남는다.",
    },
    Unserved {
        name: "unit_install_read_utf8",
        blocked_by: "디스크 스테이징이라 자원처럼 보이지만 넷이 막는다. ① stage 가 받아오는 경로가 런타임을 \
                     끌고 온다(게이트가 런타임을 이름으로 막는다) ② 매니저 **생성자가 파괴적**이다 — 만드는 \
                     순간 스테이징 디렉터리를 통째로 비우고, 앱은 그것을 부팅마다 만든다. 두 프로세스가 각자 \
                     만들면 남의 트랜잭션이 명령 이전에 사라진다 ③ commit 이 쓰는 플러그인 디렉터리에는 쓰기 \
                     소유권 표가 없다(같은 사유로 plugin_install_git 이 이미 여기 있다) ④ 원장이 프로세스 \
                     메모리라 begin 과 commit 을 다른 프로세스가 잡으면 뒤쪽은 100% 실패 경로만 남는다.",
    },
    Unserved {
        name: "service_status",
        blocked_by: "상주 서비스는 매니저를 만든 프로세스의 자식이다. 매니저가 요구하는 호스트 능력(소유자 \
                     깨우기·중재)에 대응하는 계약이 코어에 없어서, 이 프로세스가 답하면 언제나 빈 목록·못 찾음· \
                     배달 0 이다. 그 0 은 '구독자가 없다'와 구분되지 않는다 — 형제인 service_ledger_sync 가 \
                     여기 있는 것과 같은 벽이다.",
    },
    Unserved {
        name: "service_dispatch",
        blocked_by: "상주 서비스는 매니저를 만든 프로세스의 자식이다. 매니저가 요구하는 호스트 능력(소유자 \
                     깨우기·중재)에 대응하는 계약이 코어에 없어서, 이 프로세스가 답하면 언제나 빈 목록·못 찾음· \
                     배달 0 이다. 그 0 은 '구독자가 없다'와 구분되지 않는다 — 형제인 service_ledger_sync 가 \
                     여기 있는 것과 같은 벽이다.",
    },
    Unserved {
        name: "service_bus_push",
        blocked_by: "상주 서비스는 매니저를 만든 프로세스의 자식이다. 매니저가 요구하는 호스트 능력(소유자 \
                     깨우기·중재)에 대응하는 계약이 코어에 없어서, 이 프로세스가 답하면 언제나 빈 목록·못 찾음· \
                     배달 0 이다. 그 0 은 '구독자가 없다'와 구분되지 않는다 — 형제인 service_ledger_sync 가 \
                     여기 있는 것과 같은 벽이다.",
    },
    Unserved {
        name: "sidecar_open",
        blocked_by: "사이드카를 띄우는 일은 프로세스지만 이 둘의 몸은 창이다 — 동적 적재로 붙은 표면을 창의 \
                     콘텐츠 뷰에 얹고, 회신을 창 채널로 흘린다. 그 셋(동적 적재·네이티브 뷰·창 채널)이 전부 \
                     이 프로세스의 금지 이름이다. 형제인 sidecar_close 가 여기 있으니 셋이 같은 자리다. \
                     프레임워크가 답해야 하는 이름이지 코어로 옮길 이름이 아니다.",
    },
    Unserved {
        name: "sidecar_send",
        blocked_by: "사이드카를 띄우는 일은 프로세스지만 이 둘의 몸은 창이다 — 동적 적재로 붙은 표면을 창의 \
                     콘텐츠 뷰에 얹고, 회신을 창 채널로 흘린다. 그 셋(동적 적재·네이티브 뷰·창 채널)이 전부 \
                     이 프로세스의 금지 이름이다. 형제인 sidecar_close 가 여기 있으니 셋이 같은 자리다. \
                     프레임워크가 답해야 하는 이름이지 코어로 옮길 이름이 아니다.",
    },
    Unserved {
        name: "service_ledger_sync",
        blocked_by: "원장 파일 쓰기만이면 옮길 수 있다 — 그러나 이 명령의 몸은 그 다음이다. 쓰기가 \
                     내용을 바꿨을 때만 결속을 맞추는데(같으면 멱등 반환), 그 맞춤이 앱 프로세스 안의 \
                     ServiceManager 를 풀고 묶고 ScheduleState 의 예약을 소유자별로 취소한다. 파일만 \
                     쓰고 그 절반을 빼면 원장은 새 내용인데 도는 서비스는 옛 결속이라, 다음 부팅까지 \
                     둘이 어긋난 채로 성공을 답한다. 그 어긋남은 오류가 아니라 '없앤 서비스가 계속 \
                     도는 것'으로 나타난다.",
    },
    Unserved {
        name: "secret_status",
        blocked_by: "이름은 조회인데 **볼트를 만든다.** status() 는 data 봉투 키 목록을 실으려고 \
                     keys() 를 지나고, keys() 는 is_unlocked() → ensure_open() 이다. 볼트 파일이 없으면 \
                     그 자리에서 KEK 를 get-or-create 해 새 볼트를 봉인하고 flush 한다 — 읽기 프로브가 \
                     아니라 첫 호출이 키체인 항목과 볼트 파일을 만드는 쓰기다. 부팅이 키체인을 건드리지 \
                     않는 규칙(2d06843f)이 막는 것이 정확히 이 일이고, 만드는 주체가 cored 면 그 볼트는 \
                     cored 의 신원으로 잠긴다: 앱이 다음에 열려 하면 'vault↔keychain KEK 불일치'로 막힌다. \
                     열쇠 바이트를 얻는 쪽이 막히는 사유는 형제 secret_* 와 같다.",
    },
    Unserved {
        name: "project_owners",
        blocked_by: "점유 원장이 앱 프로세스 안의 가변 상태다. 살아 있는 창 라벨은 인자로 받을 수 \
                     있지만(부팅 상태가 홈을 받는 것처럼) 원장은 못 받는다 — 그것을 바꾸는 \
                     claim/release 가 같은 프로세스에 있다. cored 가 원장을 쥐면 원장의 수명이 cored 의 \
                     수명이 되어, 프레임워크가 재기동한 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다.",
    },
    Unserved {
        name: "net_http_request",
        blocked_by: "벽은 볼트다. 시크릿 치환이 앱이 연 볼트(SecretsState)를 읽으므로, 옮기려면 키체인 \
                     신원과 잠금 수명까지 함께 옮겨야 한다 — 이 프로세스는 볼트를 열지 않는다는 결정과 \
                     정면으로 부딪힌다. soksak-net 의 request 는 이미 resolver 를 인자로 받으므로 \
                     resolver 없는 요청은 지금도 가능하지만, 그러면 같은 이름이 프로세스마다 다른 \
                     능력을 갖는다. tokio 는 벽이 아니다: no_framework 목록이 이름으로 막지만 그 \
                     목록의 기준(창을 여는가·앱 핸들을 쥐는가·프로세스마다 답이 갈리는가)에 tokio 는 \
                     걸리지 않고, soksak-net 은 같은 기준으로 tokio 를 자원이라 적었다. 그 이름은 \
                     실제 소비자가 생기는 커밋에서 재입법한다 — 쓸 곳 없이 미리 여는 것은 결정을 \
                     감추는 것이다.",
    },
    Unserved {
        name: "process_reclaim_window",
        blocked_by: "창이 프레임워크 주입이라 이 이름의 호출자는 인자를 보내지 않는다. 이 프로세스에는 \
                     창이 없어 라벨을 받아야 하는데, 같은 이름으로 받으면 인자 없이 부른 UI 가 \
                     INVALID_PARAMS 를 받는다 — 그 실패는 '회수가 안 된다'가 아니라 '명령이 깨졌다'로 \
                     보인다. 능력 자체는 있다: 라벨을 받는 process_reclaim_by_window 를 프레임워크가 부른다.",
    },
    Unserved {
        name: "app_relaunch",
        blocked_by: "교체 대상이 곧 호출을 받은 프로세스다. 몸이 app.restart() 한 줄인데 그것은 `!` 라 \
                     Ok 경로가 없다 — cored 가 같은 이름을 서빙하면 되살아나는 것은 cored 고, 앱은 \
                     그대로 옛 판으로 돈다. 그 답은 성공이라 호출자는 새 판이 떴다고 믿는다. 재기동이 \
                     지나야 하는 종료 사다리 일곱(PtyManager·daemon·ProcessManager·ServiceManager· \
                     WsManager·ipc·sidecar) 도 전부 앱 프로세스의 상태 위에 있다.",
    },
    Unserved {
        name: "sidecar_close",
        blocked_by: "닫는 대상이 이 프로세스가 dlopen 한 모듈의 클라이언트 맵(static MODULES)이고, 그 \
                     값은 tauri::ipc::Channel 이다 — 프레임워크 타입이라 여기서는 만들 수도 담을 수도 \
                     없다. 맵을 채우는 sidecar_open 은 창의 엔진 호스트 NSView 를 모듈에 주입하므로, \
                     핸들 번호만 받아서는 닫을 것이 생기지 않는다. 없는 맵에서 remove 하면 Ok 인데 \
                     채널은 앱 쪽에 열린 채로 남는다.",
    },
    Unserved {
        name: "sidecar_ensure",
        blocked_by: "\"present\" 는 파일 하나 보면 답할 수 있지만 \"fetched\" 를 만드는 것은 다운로드다 — \
                     runtime_dep::download_unpack_verify 가 wreq 를 타고 wreq 는 tokio 를 끌고 온다. \
                     이 프로세스의 no_framework 게이트가 tokio 를 이름으로 막는다(download_verify 와 \
                     같은 벽). 받는 걸음을 빼고 present 만 답하면 미설치가 \"설치됨\"과 같은 모양이 되고, \
                     그 다음 app.sidecar.open 이 dlopen 에서 처음 깨진다.",
    },
    Unserved {
        name: "clipboard_read",
        blocked_by: "OS 클립보드를 읽는 것이 명령의 전부인데 그 클라이언트가 전부 네이티브다 — \
                     clipboard-rs·objc2·x11rb 가 이 프로세스의 no_framework 금지 목록에 이름으로 있고, \
                     X11 경로는 선택 전송을 받을 창까지 필요하다(cored 에는 창이 없다). 게다가 이 명령의 \
                     계약은 실패를 빈 문자열로 답하는 것이라(비텍스트 클립 = \"\"), 못 읽어서 낸 \"\" 가 \
                     '텍스트가 아닌 클립'과 글자 하나 다르지 않다.",
    },
    Unserved {
        name: "media_proxy_info",
        blocked_by: "프록시의 몸이 soksak-net 이고, 그 전송기는 wreq 하나인데 wreq 는 tokio 를 끌고 온다 — \
                     이 프로세스의 no_framework 게이트가 tokio 를 이름으로 막는다(net_http_request 와 \
                     같은 벽). 답할 포트·토큰이 전역이라서 막히던 것은 아니다: start() 가 손잡이를 \
                     돌려주므로 프록시를 세운 쪽이 자기 것을 답하고, 여기서 세우면 여기 것을 답한다.",
    },
    Unserved {
        name: "ipc_last_project_window",
        blocked_by: "포커스 **규칙**은 이미 코어의 것이고(control::FocusLedger) cored 도 그 장부를 \
                     하나 쥔다 — control_host_attach·control_windows 로 붙은 호스트가 자기 창 사실을 \
                     보고하면 last_workspace 가 그 자리에서 갱신된다. 그러니 옛 사유('cored 는 그 사건을 \
                     받지 않는다')는 더 이상 사실이 아니다. 남은 벽은 **보고하지 않는 프레임워크**다: \
                     붙는 쪽은 Electron 하나이고 Tauri 앱은 자기 창 사건을 자기 프로세스 장부에만 적는다. \
                     그 홈에서 cored 가 같은 이름을 답하면 언제나 null 인데, 이 명령의 null 은 \
                     '워크스페이스 창을 포커스한 적 없다'는 뜻이라 부재와 구분되지 않는다 — 그 null 을 받은 \
                     orchestrator.ask 는 무대를 잃는다. 표로 올리려면 붙는 쪽이 먼저 둘이어야 한다.",
    },
    Unserved {
        name: "unit_dev_set",
        blocked_by: "공유 config(development-units.json)의 read-modify-write 인데, 그 직렬화가 앱 프로세스 \
                     안의 static WRITE_LOCK 하나다. 두 프로세스가 각자 그 Mutex 를 잡으면 서로를 못 보고, \
                     겹친 쓰기가 남의 선언을 지운 채로 성공을 답한다. store_lock 은 이 자리를 대신하지 \
                     못한다 — 그것은 app.data 의 쓰기 소유권이고 앱은 그것을 잡지도 않는다. 앞머리의 \
                     dev identity 게이트까지 옮겨도 잠금은 여전히 갈라진다.",
    },
    Unserved {
        name: "unit_dev_remove",
        blocked_by: "지우는 것도 같은 공유 config 의 read-modify-write 이고 같은 static WRITE_LOCK 하나에 \
                     직렬화된다(unit_dev_set 과 같은 벽). 프로세스가 둘이면 그 잠금은 서로를 모른다 — \
                     겹치면 removed:true 를 답하면서 남의 항목까지 되살리거나 지운다. store_lock 은 \
                     app.data 잠금이라 이 파일을 지키지 않는다.",
    },
    Unserved {
        name: "plugin_install_git",
        blocked_by: "명령의 몸이 원격 트리를 가져오는 것 자체다 — git clone 스폰을 빼면 남는 일이 없다. \
                     그 스폰은 core-git-scan 게이트가 plugins.rs 한 파일로 봉인해 두었고(ALLOWLIST 단 \
                     한 줄), 여기에 같은 스폰을 두는 것은 봉인을 넓히는 재입법이다. 그리고 <홈>/plugins \
                     트리에는 쓰기 소유권 표가 없다 — store_lock 은 app.data 만 지켜서, 앱과 cored 가 \
                     같은 디렉터리에 동시에 설치해도 누구도 막지 않는다.",
    },
    Unserved {
        name: "plugin_update",
        blocked_by: "fetch 후 원격 상태로 강제 동기화하는 것이 명령의 몸이라, git 스폰을 빼면 설치본은 \
                     그대로인데 성공이 나간다. 그 스폰은 core-git-scan 이 plugins.rs 한 파일로 봉인했다 \
                     (plugin_install_git 과 같은 벽). <홈>/plugins 트리 쓰기 소유권 표도 없어, 읽기전용 \
                     잠금을 풀고 reset --hard 하는 동안 앱이 같은 트리를 만지는 것을 아무도 막지 못한다.",
    },
    Unserved {
        name: "plugin_dev_new",
        blocked_by: "앞절반(스캐폴드 파일 방출)은 옮길 수 있지만 뒷절반이 git init 스폰과 \
                     unit_dev::set_source — 곧 development-units.json 쓰기다. 그 스폰은 core-git-scan 이 \
                     plugins.rs 로 봉인했고 그 쓰기는 앱 프로세스의 static WRITE_LOCK 에 직렬화된다 \
                     (unit_dev_set 과 같은 벽). 원본은 둘을 한 트랜잭션으로 묶어 실패하면 디렉터리를 \
                     지운다 — 뒷절반을 빼면 답은 성공인데 유닛은 아무도 적재하지 않는 workspace 반쪽만 \
                     남는다.",
    },
    Unserved {
        name: "plugin_dev_new2",
        blocked_by: "이름에 soksak-plugin- 접두를 붙이는 것만 다르고 몸은 plugin_dev_new 과 같다 — 뒷절반이 \
                     git init 스폰(core-git-scan 봉인)과 unit_dev::set_source 의 development-units.json \
                     쓰기(앱 프로세스 static WRITE_LOCK)다. 뒷절반을 빼면 선언되지 않은 workspace 반쪽을 \
                     남기고 성공을 답한다.",
    },
    Unserved {
        name: "sidecar_dev_new",
        blocked_by: "사이드카 스캐폴드도 같은 트랜잭션이다 — 방출 뒤에 git init 스폰(core-git-scan 이 \
                     plugins.rs 로 봉인)과 unit_dev::set_source 의 development-units.json 쓰기(앱 프로세스 \
                     static WRITE_LOCK)가 따라붙고, 실패하면 디렉터리를 지운다. 뒷절반을 빼면 유닛은 \
                     선언되지 않아 어느 홈에서도 적재되지 않는데 답은 성공이다.",
    },
];
