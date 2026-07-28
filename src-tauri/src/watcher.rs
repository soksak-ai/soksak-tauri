// 파일시스템 워처의 **이 프레임워크 진입점** — 감시 규칙은 코어가 소유한다
// (soksak-watch). 여기 있는 것은 뿌리는 자리(창 emit)와 커맨드 껍질뿐이다.

pub(crate) use soksak_watch::FsWatcher;

use tauri::{AppHandle, Emitter, State};

/// 앱 setup 에서 1회 초기화 — 변경된 디렉토리를 창에 뿌린다.
pub(crate) fn init(watcher: &FsWatcher, app: AppHandle) {
    watcher.init_with(move |d| {
        let _ = app.emit("fs-change", d);
    });
}

// 디렉토리 하나를 비재귀로 감시. lazy 트리가 폴더를 로드할 때·플러그인이 fs.watch 로 호출.
// 반환 = 등록 후 refcount.
#[tauri::command]
pub fn watch_dir(state: State<FsWatcher>, path: String) -> Result<usize, String> {
    state.watch(&path)
}

// 디렉토리 감시 해제(트리 언마운트·서브트리 삭제 시 FSEvents 핸들 정리). 반환 = 해제 후 refcount.
#[tauri::command]
pub fn unwatch_dir(state: State<FsWatcher>, path: String) -> Result<usize, String> {
    state.unwatch(&path)
}
