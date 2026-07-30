//! 예약 명세 — 트리거·재시도·잡 한 벌.
//!
//! 순수 serde 타입이다. 스케줄러와 서비스 원장이 **둘 다** 이 모양을 쓰는데, 한쪽 프레임워크
//! 파일에 두면 다른 쪽이 그 파일을 의존하게 되고 그 순간 둘 다 그 프로세스에 묶인다.

use serde_json::Value;

// ── 트리거·정책 ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Trigger {
    At {
        at: u64,
    },
    Every {
        every_ms: u64,
        #[serde(default)]
        anchor: Option<u64>,
    },
    Cron {
        expr: String,
    },
    Reconcile,
}

impl Trigger {
    pub fn is_time_based(&self) -> bool {
        !matches!(self, Trigger::Reconcile)
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Retry {
    pub max: u32,     // 최대 재시도 횟수(0=재시도 없음).
    pub base_ms: u64, // backoff 기준(첫 재시도 지연).
    pub max_ms: u64,  // backoff 상한.
}

// 등록 명세(영속 직렬화 단위이기도 하다 — 시간 기반만 저장).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct JobSpec {
    #[serde(default)]
    pub id: Option<String>,
    pub trigger: Trigger,
    pub command: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub retry: Option<Retry>,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    // 발화 1회당 명령 응답 대기 상한(ms). 비-프로세스 작업 전용(예: notify.show). 미지정 시 30s
    // (route 가 [1s,3600s] 클램프). process_lease 작업은 이 값을 안 쓰고 프로세스-생존 lease 로 대기한다.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    // 프로세스-생존 lease opt-in. true = 발화 명령이 exec-one 프로세스를 돌리고 onExit 까지 reply 를
    // 보류한다(main.js). 코어는 reply(프로세스 exit)까지 lease 를 쥐고 기다린다 — 도는 동안(검색 1h 든)
    // 절대 안 자른다. 좀비(reply 영영 없음)만 zombie_backstop_ms 에 거둔다. false = 현행 timeout_ms 경로.
    // (스케줄러는 명령이 프로세스형인지 introspect 못 하므로 명시 opt-in.)
    #[serde(default)]
    pub process_lease: bool,
    // 프로세스-생존 작업의 좀비 backstop(ms, claim 이후). reply 가 영영 안 올 때만 거둔다(프로세스 zombie·
    // 프론트 wedge). None=무한(reply/cancel 까지). JS 가 process_lease 시 미지정이면 3h 를 주입한다.
    #[serde(default)]
    pub zombie_backstop_ms: Option<u64>,
    // 소유자(플러그인 id) — 이 잡을 등록한 주체. Some(플러그인)이면 코어는 persist 하지 않는다:
    // 플러그인 잡은 세션-스코프이고 플러그인이 activate 에서 재장전하며 deactivate 시 취소된다(api.ts
    // tracker). 그래서 부팅 재장전(reload_persisted)은 코어 잡(owner=None)만 → 비활성 플러그인 잡의
    // orphan 발화가 원천 차단된다. None=코어 등록(시간기반이면 persist).
    #[serde(default)]
    pub owner: Option<String>,
}

pub fn default_concurrency() -> u32 {
    1
}
