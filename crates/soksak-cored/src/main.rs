// soksak-cored — 프레임워크 없이 명령을 서빙하는 프로세스.
//
// 창도, 웹뷰도, 앱 핸들도 없다. 소켓으로 명령을 받아 soksak-core 의 로직으로 답한다.
// 어떤 프레임워크(Electron 이든 무엇이든)가 붙어도 같은 답이 나오는 것이 존재 이유다.
//
// 선례는 soksak-ptyd 다(독립 cored 프로세스: 소켓 bind·요청 루프·수명). 다만 두 가지가 다르다:
//   ① 홈을 전역으로 알지 않는다. ptyd 는 SOKSAK_HOME 을 읽어 경로를 파생하지만, 이 프로세스는
//      **소켓 경로를 인자로 받는다**. cored 가 identity 를 추측하는 순간 홈이 갈릴 때 조용히 다른
//      곳에 붙는다 — 어느 홈에 서빙하는지는 띄우는 쪽이 안다(Identity 원칙).
//   ② 데이터 평면이 없다. 요청/응답 소켓 한 본뿐이다(스트림 소켓·토큰은 프레임워크를 소유할 때의 비용).
//
// 여기 있는 것은 배선뿐이다. 로직은 soksak-core 이, 표는 registry 가, 봉투는 wire 가 소유한다.
// 서빙 대상은 **프레임워크 없이도 같은 답이 나오는 명령**으로 한정한다 — 네이티브(창·웹뷰·엔진)는
// 프레임워크에 남고, cored 는 그것을 아는 척하지 않는다(모르는 이름은 이름을 달고 실패한다).

const USAGE: &str = "\
soksak-cored — serves framework-free commands over a socket

USAGE:
    soksak-cored --socket <path> --home <path> --identifier <id>
                 [--data-dir <path>] [--user-home <path>] [--login-shell <path>]

OPTIONS:
    --socket <path>      Unix socket to bind and serve (required)
    --home <path>        identity home this helper serves (required)
    --identifier <id>    identity of that home, e.g. com.soksak.dev (required)
    --data-dir <path>    app.data directory, when the spawner moved it (default: <home>/data)
    --user-home <path>   the OS user home — the file tree's root and what `~` expands to.
                         This is NOT the identity home: `~/.soksak-dev` is the identity home
                         and `~` is this. Without it, calls that need a home fail by name;
                         everything else still serves. It is never derived from --home,
                         because the parent-directory relation holds only in the shipped
                         layout and points somewhere else under isolation.
    --login-shell <path> user login shell. $SHELL belongs to the user account, not to this
                         process — the spawner reads it once and passes it as a value. Without
                         it, shell-backed commands refuse by name instead of guessing.
    --help               print this and exit
    --version            print the version and the socket protocol it speaks

Every one of these is an argument on purpose: this process derives no identity of
its own. Whoever spawns it knows which home it serves, and passes it in — the same
way the app receives its identity from its framework config at boot. Receiving is not
guessing; a helper that guessed would answer for a different home, silently.

Commands take the same arguments as the app commands of the same name. Process
state (identity, home, store path) is boot state here, never a per-call argument:
the UI does not know which process answers it.

Once bound it prints one readiness line to stdout, then serves NDJSON
request/response lines. Ask it `cored.commands` for what it serves.";

use soksak_core::identity::Identity;
use soksak_cored::ctx::Ctx;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!(
            "soksak-cored {} (socket protocol {})",
            env!("CARGO_PKG_VERSION"),
            soksak_spec_socket::SOCKET_PROTOCOL_VERSION,
        );
        return;
    }

    // 소켓 경로가 없으면 기본값을 고르지 않고 이름을 달고 실패한다. 조용히 어딘가에
    // 붙는 cored 는 붙은 곳이 틀려도 성공처럼 보인다.
    let (socket, ctx) = match boot(&args) {
        Ok(v) => v,
        Err(why) => {
            eprintln!("soksak-cored: {why}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    #[cfg(not(unix))]
    {
        let _ = (socket, ctx);
        eprintln!("soksak-cored: unix only in this generation (named pipes land with the Windows framework)");
        std::process::exit(1);
    }
    #[cfg(unix)]
    unix::serve(std::path::Path::new(&socket), ctx);
}

/// 부팅 인자 → 소켓 경로 + 서빙 상태. 빠진 것은 기본값을 고르지 않고 이름을 달고 실패한다:
/// 홈을 추측하는 cored 는 **다른 identity 의 답을 성공처럼** 돌려준다.
fn boot(args: &[String]) -> Result<(String, Ctx), String> {
    let socket = take_value(args, "--socket")?;
    let home = take_value(args, "--home")?;
    let identifier = take_value(args, "--identifier")?;
    // 자기가 서빙하는 소켓을 지고 간다 — 이 프로세스가 띄우는 셸의 `SOKSAK_SOCKET` 이 이 값이다.
    let mut ctx = Ctx::new(Identity::new(home, identifier)).with_socket_path(socket.clone());
    // 데이터 경로 이동은 띄운 쪽만 안다(앱의 debug 전용 격리). 안 주면 홈에서 파생한다.
    if let Ok(shell) = take_value(args, "--login-shell") {
        ctx = ctx.with_login_shell(shell);
    }
    if let Ok(dir) = take_value(args, "--data-dir") {
        ctx = ctx.with_data_dir(dir);
    }
    // 사용자 홈도 띄운 쪽만 안다. 안 주면 파생하지 않는다 — 홈이 필요한 명령만 이름을 달고
    // 거절하고 나머지는 계속 서빙한다.
    if let Ok(dir) = take_value(args, "--user-home") {
        ctx = ctx.with_user_home(dir);
    }
    // 쓰기 소유권을 부팅에서 한 번 시도한다. 못 잡는 것은 실패가 아니라 **읽기 서버로
    // 산다**는 뜻이다(그 홈의 앱이 도는 정상 상태). 잠금 자체를 못 만드는 것만 오류다.
    ctx.claim_writes()?;
    Ok((socket, ctx))
}

/// `--flag value` 한 쌍을 읽는다. 빠진 것과 값 없는 것을 서로 다른 사유로 말한다.
fn take_value(args: &[String], flag: &str) -> Result<String, String> {
    let Some(at) = args.iter().position(|a| a == flag) else {
        return Err(format!("{flag} <path> 가 필요합니다"));
    };
    match args.get(at + 1) {
        Some(v) if !v.starts_with('-') => Ok(v.clone()),
        _ => Err(format!("{flag} 에 값이 없습니다")),
    }
}

#[cfg(unix)]
mod unix {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    use soksak_cored::ctx::Ctx;

    pub fn serve(socket: &Path, ctx: Ctx) {
        // 싱글턴 프로브 — 살아 있는 응답자가 그 경로를 서빙하면 물러난다(ptyd 와 같은 판정).
        // 죽은 소켓 파일만 치운다: 연결이 되는 소켓을 지우면 남의 서빙을 끊는다.
        if socket.exists() {
            if UnixStream::connect(socket).is_ok() {
                eprintln!("soksak-cored: another helper serves {socket:?}; exiting");
                std::process::exit(0);
            }
            let _ = std::fs::remove_file(socket);
        }
        if let Some(parent) = socket.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("soksak-cored: cannot create {parent:?}: {e}");
                std::process::exit(2);
            }
        }
        let listener = match UnixListener::bind(socket) {
            Ok(l) => l,
            Err(e) => {
                // 경로 길이는 여기서 가장 흔하게 걸린다: 유닉스 소켓 경로에는 OS 상한이 있고
                // (macOS ~104, Linux ~108 바이트) 깊은 트리에서 조용히 넘긴다. 상한 숫자는
                // OS 가 소유하므로 여기서 못박지 않고, 대신 실제 길이를 함께 말해 준다 —
                // "path must be shorter than SUN_LEN" 만으로는 얼마나 긴지 알 수 없다.
                eprintln!(
                    "soksak-cored: bind {socket:?} failed: {e} (socket path is {} bytes; \
                     unix socket paths have an OS length limit — pass a shorter --socket)",
                    socket.as_os_str().len(),
                );
                std::process::exit(2);
            }
        };
        // 로컬 사용자 전용(0600) — 앱 소켓과 같은 하한.
        let _ = std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600));

        // 준비 완료 신호 = stdout 한 줄. 띄운 쪽은 이 줄에서 블로킹 read 로 기다린다 —
        // 소켓 파일이 생겼는지 반복해 보는 폴링이 필요 없고(파일 존재 != bind 완료),
        // cored 가 먼저 죽으면 EOF 로 즉시 드러난다.
        println!("soksak-cored: listening {}", socket.display());
        let _ = std::io::stdout().flush();

        // 서빙 상태는 연결마다 공유된다 — 한 cored 는 한 정체성을 서빙한다.
        let ctx = std::sync::Arc::new(ctx);

        // **메인스레드는 accept 에 내주지 않는다.** accept 는 어느 스레드에서나 같은 답을
        // 내지만 엔진 init 은 그렇지 않다(메인스레드 계약, SIDECARS.md §3). 자리를 잘못 주면
        // 이 프로세스는 그 계약을 영영 못 지키고, 그 사실은 사이드카를 열려는 순간에야 드러난다.
        let rx = soksak_cored::main_thread::install();
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let ctx = ctx.clone();
                std::thread::spawn(move || handle_conn(&ctx, conn));
            }
        });
        match rx {
            // 큐가 닫히면(보낸 쪽이 전부 사라지면) 반환한다 — 그때 프로세스가 끝난다.
            Some(rx) => soksak_cored::main_thread::pump(rx),
            // 두 번 세울 수 없다. 그런 부팅은 없지만, 조용히 지나가면 accept 스레드만 살아
            // 프로세스가 답은 하는데 엔진은 못 여는 반쪽이 된다.
            None => eprintln!("soksak-cored: 메인스레드 자리를 두 번 세울 수 없다"),
        }
    }

    // 연결 하나 = NDJSON 루프. **읽기만 직렬이고 답은 겹친다.**
    //
    // 프로토콜에 id 가 있는 것은 한 연결에 요청을 겹쳐도 짝이 정해진다는 약속이다 — 다리는 그
    // 약속 위에 유지 연결 하나로 전부를 보낸다. 한 요청을 끝내고 다음 줄을 읽으면 느린 명령
    // 하나가 뒤를 전부 막고, 그 증상은 원인에서 한참 떨어져 보인다(실측: 부팅에서
    // process_spawn 이 30초 상한까지 답을 못 받았는데 직접 부르면 3ms 였다).
    //
    // 그래서 요청마다 스레드를 띄운다. 연결이 지고 가는 것(쓰기 자리·다리 여부·스트림 토큰)은
    // 값으로 공유한다 — 스레드 지역이면 답하는 스레드가 그것을 못 본다.
    fn handle_conn(ctx: &std::sync::Arc<Ctx>, conn: UnixStream) {
        let Ok(read_half) = conn.try_clone() else { return };
        let reader = BufReader::new(read_half);
        let state = std::sync::Arc::new(soksak_cored::wire::Conn::new(conn));
        let mut workers = Vec::new();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            // 연결의 성질을 밝히는 줄은 **읽은 자리에서** 세운다. 동시 처리에 넘기면 그 선언이
            // 첫 명령보다 늦게 설 수 있고, 그때 이 연결은 자기가 무엇인지 모른 채로 답한다.
            if let Some(reply) = soksak_cored::wire::answer_declaration(&ctx, &line, &state) {
                state.reply(&reply);
                continue;
            }
            let (ctx, state) = (ctx.clone(), state.clone());
            workers.push(std::thread::spawn(move || {
                let reply = soksak_cored::wire::answer_on_conn(&ctx, &line, &state);
                state.reply(&reply)
            }));
            // 끝난 일꾼은 거둔다 — 오래 사는 연결(다리)이 스레드 핸들을 무한정 쌓지 않게.
            workers.retain(|w| !w.is_finished());
        }
        // 답이 나가는 중에 연결을 놓으면 그 답이 사라진다 — 전부 기다린 뒤에 놓는다.
        for w in workers {
            let _ = w.join();
        }
        state.release();
    }
}

#[cfg(test)]
mod tests {
    use super::take_value;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_socket_path_is_read_from_the_argument() {
        assert_eq!(
            take_value(&argv(&["--socket", "/run/h.sock"]), "--socket").unwrap(),
            "/run/h.sock"
        );
    }

    // 빠진 것과 값 없는 것은 다른 실수다 — 사유가 달라야 고칠 곳을 안다.
    #[test]
    fn a_missing_flag_and_a_valueless_flag_read_differently() {
        let missing = take_value(&argv(&[]), "--socket").unwrap_err();
        assert!(missing.contains("--socket"), "{missing}");
        let valueless = take_value(&argv(&["--socket"]), "--socket").unwrap_err();
        assert!(valueless.contains("값이 없습니다"), "{valueless}");
        // 다음 플래그를 값으로 삼키지 않는다.
        assert!(take_value(&argv(&["--socket", "--help"]), "--socket").is_err());
    }

    // 도움말은 부르는 법(필수 인자)을 말해야 한다.
    #[test]
    fn the_usage_names_the_required_argument() {
        assert!(super::USAGE.contains("soksak-cored"));
        assert!(super::USAGE.contains("--socket"));
    }
}
