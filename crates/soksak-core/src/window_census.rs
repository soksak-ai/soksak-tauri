//! 창 점유 장부의 **모양** — 만드는 쪽이 둘이라 한 자리에 둔다.
//!
//! "지금 어느 창이 살아 있는가"는 두 곳에서 만들어진다: 붙은 호스트를 전부 아는 cored 와,
//! cored 없이 홀로 도는 프레임워크(그때는 자기 창이 곧 전부다). 부르는 쪽은 누가 답했는지
//! 모른다 — 모양이 갈리면 한쪽에서만 조용히 파싱이 비고, 빈 결과는 "아무도 안 들었다"로 읽혀
//! **전부 되살리게 된다.** 그것이 이 장부가 막으려는 겹침 그 자체다(ARCHITECTURE A23).
//!
//! 이 모듈은 모양만 정한다. 누가 창을 들었는지는 각 프로세스가 안다.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 한 줄 = 한 라벨. `hosts` 는 그 라벨을 든 호스트 수(둘 이상이면 겹쳤다는 뜻이다).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowRow {
    pub label: String,
    pub hosts: u64,
    pub focused: bool,
}

/// 라벨 목록 → 장부. 호스트가 하나뿐인 프로세스가 쓴다(겹칠 상대가 없으므로 hosts=1).
pub fn of_labels<I, S>(labels: I, focused: Option<&str>) -> Vec<WindowRow>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    labels
        .into_iter()
        .map(|l| {
            let label = l.as_ref().to_string();
            let is_focused = focused == Some(label.as_str());
            WindowRow { label, hosts: 1, focused: is_focused }
        })
        .collect()
}

/// 같은 라벨을 여러 호스트가 들었으면 한 줄로 접고 `hosts` 를 올린다.
///
/// 합쳐서 하나로 답하지 않는 이유는 세는 자리가 여기이기 때문이다 — **어느 창인지 못 고르는
/// 것과 창이 하나인 것은 다른 사실이다**(배달은 그 겹침을 이름으로 거절한다).
pub fn fold(rows: impl IntoIterator<Item = WindowRow>) -> Vec<WindowRow> {
    let mut out: Vec<WindowRow> = Vec::new();
    for r in rows {
        match out.iter_mut().find(|w| w.label == r.label) {
            Some(w) => {
                w.hosts += 1;
                w.focused = w.focused || r.focused;
            }
            None => out.push(r),
        }
    }
    out
}

/// 답 봉투. 키 이름이 여기서만 정해진다 — 소비자가 이 키로 찾는다.
pub fn reply(rows: Vec<WindowRow>) -> Value {
    serde_json::json!({ "windows": rows })
}

/// 남의 답에서 장부를 꺼낸다 — 봉투로 왔든(`data.windows`) 알맹이로 왔든(`windows`).
///
/// 모양이 아니면 **`None` 이다.** 빈 목록으로 뭉개면 "못 읽었다"와 "아무도 안 들었다"가 같아지고,
/// 뒤엣것은 전부 되살리라는 뜻이라 정반대로 움직인다.
pub fn from_reply(v: &Value) -> Option<Vec<WindowRow>> {
    let rows = v.get("data").and_then(|d| d.get("windows")).or_else(|| v.get("windows"))?;
    serde_json::from_value(rows.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 홀로_도는_프로세스는_자기_창이_전부다() {
        let rows = of_labels(["main", "w-1"], Some("w-1"));
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.hosts == 1));
        assert!(rows.iter().find(|r| r.label == "w-1").unwrap().focused);
    }

    #[test]
    fn 같은_라벨을_둘이_들면_한_줄에_둘로_센다() {
        let folded = fold([
            WindowRow { label: "main".into(), hosts: 1, focused: false },
            WindowRow { label: "main".into(), hosts: 1, focused: true },
            WindowRow { label: "w-1".into(), hosts: 1, focused: false },
        ]);
        assert_eq!(folded.len(), 2);
        let main = folded.iter().find(|r| r.label == "main").unwrap();
        assert_eq!(main.hosts, 2, "겹침은 수로 보여야 한다 — 하나로 접으면 창이 하나로 읽힌다");
        assert!(main.focused, "한 호스트가 포커스를 들었으면 그 사실이 남는다");
    }

    #[test]
    fn 봉투로_와도_알맹이로_와도_같은_자리를_집는다() {
        let rows = vec![WindowRow { label: "w-1".into(), hosts: 1, focused: false }];
        let bare = reply(rows.clone());
        let wrapped = serde_json::json!({ "ok": true, "data": bare.clone() });
        assert_eq!(from_reply(&bare).unwrap(), rows);
        assert_eq!(from_reply(&wrapped).unwrap(), rows);
    }

    #[test]
    fn 모양이_아니면_빈_목록이_아니라_없음이다() {
        // 빈 목록은 "아무도 안 들었다"라서 전부 되살리라는 뜻이 된다 — 정반대로 움직인다.
        assert!(from_reply(&serde_json::json!({ "ok": false })).is_none());
        assert!(from_reply(&serde_json::json!({ "windows": "말이 안 되는 값" })).is_none());
    }
}
