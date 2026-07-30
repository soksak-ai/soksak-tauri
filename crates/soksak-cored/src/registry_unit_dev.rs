//! 개발 선언의 몸 — soksak-core::unit_dev 가 진다. 여기 있는 것은 배선뿐이다.
//!
//! 적혀 있던 벽 둘이 사라졌다. 잠금은 프로세스 안의 Mutex 였고 그것은 프로세스 둘을 못 막는다 —
//! 커널 파일 잠금으로 바꿨다. 몸은 프레임워크 폴더에 있었고 — 코어로 옮겼다. 홈과 빌드 축은
//! 인자로 흐른다: 여기서 환경을 캐면 같은 코드가 프로세스마다 다른 홈을 본다.

use serde_json::Value;

use soksak_core::unit_dev;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};

#[derive(serde::Deserialize)]
struct Set {
    kind: String,
    id: String,
    source: String,
}

pub(crate) fn run_unit_dev_set(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Set| {
        // dev 홈 전용 — 규칙은 코어가 소유한다. 여기서 다시 판정하면 두 프로세스가 같은 이름에
        // 다른 기준을 갖는다.
        unit_dev::ensure_dev_identity_build(&soksak_core::identity::core_build_for_identifier(
            ctx.identity().identifier(),
        ))?;
        unit_dev::set_source(
            ctx.identity().home(),
            &a.kind,
            &a.id,
            std::path::Path::new(&a.source),
        )
    })
}

#[derive(serde::Deserialize)]
struct Remove {
    kind: String,
    id: String,
}

/// 제거는 어디서나 선다 — 잔재 수습을 막지 않는다(코어의 규칙 그대로).
pub(crate) fn run_unit_dev_remove(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Remove| {
        unit_dev::remove_source(ctx.identity().home(), &a.kind, &a.id)
    })
}
