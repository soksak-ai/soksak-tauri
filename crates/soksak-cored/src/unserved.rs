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
        name: "project_owners",
        blocked_by: "점유 원장이 앱 프로세스 안의 가변 상태다. 살아 있는 창 라벨은 인자로 받을 수 \
                     있지만(부팅 상태가 홈을 받는 것처럼) 원장은 못 받는다 — 그것을 바꾸는 \
                     claim/release 가 같은 프로세스에 있다. cored 가 원장을 쥐면 원장의 수명이 cored 의 \
                     수명이 되어, 프레임워크가 재기동한 뒤에도 죽은 창의 점유가 남아 그 프로젝트를 다시 못 연다.",
    },
    Unserved {
        name: "app_relaunch",
        blocked_by: "교체 대상이 곧 호출을 받은 프로세스다. 몸이 app.restart() 한 줄인데 그것은 `!` 라 \
                     Ok 경로가 없다 — cored 가 같은 이름을 서빙하면 되살아나는 것은 cored 고, 앱은 \
                     그대로 옛 판으로 돈다. 그 답은 성공이라 호출자는 새 판이 떴다고 믿는다. 재기동이 \
                     지나야 하는 종료 사다리도 전부 앱 프로세스의 상태 위에 있다(PtyManager·daemon· \
                     ProcessManager·ServiceManager·ipc·sidecar — ws 는 몸이 soksak-net 으로 \
                     나가 그 크레이트가 자기 세션을 거둔다).",
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
        blocked_by: "tokio 는 더 이상 벽이 아니다 — 이 프로세스는 이미 soksak-net 을 지고 그 위에서 \
                     ws 를 서빙한다(2026-07-30). 남은 것은 **누가 프록시를 세우는가**라는 결정 하나다: \
                     이 이름은 답할 포트·토큰이 있어야 답할 수 있고, start() 가 손잡이를 돌려주므로 \
                     세운 쪽이 자기 것을 답한다. 여기서 세우면 홈마다 루프백 리스너가 하나 더 생기고 \
                     프레임워크의 것과 둘이 된다 — 그것을 정하지 않은 채 이름만 올리면 부른 쪽은 어느 \
                     프록시를 받았는지 모른다. 쓸 곳 없이 미리 열지 않는다.",
    },
    Unserved {
        name: "pty_pane_pid",
        blocked_by: "이 pane 의 백엔드가 둘 중 무엇인지부터 앱 프로세스의 세션 원장이 안다. 데몬 \
                     백엔드면 여기서도 답할 수 있지만(PanePid 요청), 로컬 백엔드는 그 pty master 가 \
                     **앱 프로세스 안**에 있어 프로세스 그룹 리더를 여기서 볼 길이 없다. 그런데 이 \
                     명령의 None 은 '전경 프로세스가 없다'는 뜻이라, 남의 세션이어서 못 본 것과 \
                     구분되지 않는다 — 그 None 을 받은 쪽은 셸이 비었다고 읽는다. 원장이 한 프로세스로 \
                     모이기 전에는 이 이름을 나눠 답할 수 없다.",
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
];
