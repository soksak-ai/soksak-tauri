//! 새 유닛 스캐폴드의 몸 — soksak-scaffold 가 진다. 여기 있는 것은 배선뿐이다.
//!
//! 벽 둘이 사라졌다. 개발 선언 쓰기는 커널 파일 잠금이 되었고(unit_dev_set 이 서빙된다),
//! 몸은 크레이트로 나왔다. git init 은 여전히 이 스캐폴드 안에 있지만 그 자리는 core-git-scan
//! 의 명시 allowlist 에 이름으로 등재되어 있다 — 봉인을 푼 것이 아니라 자리를 밝힌 것이다.
//!
//! 트랜잭션은 하나다: 스캐폴드 → 개발 선언. 뒷절반이 빠지면 답은 성공인데 유닛은 아무도
//! 적재하지 않는 workspace 반쪽만 남는다. 그래서 실패하면 디렉터리를 지운다.

use serde_json::Value;

use soksak_core::unit_dev;

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};
use crate::registry_store::deny_without_write_ownership;

/// 스캐폴드와 개발 선언을 **한 손**으로 묶는다.
fn with_declaration(
    ctx: &Ctx,
    kind: &str,
    made: soksak_scaffold::PluginInstallResult,
) -> Result<soksak_scaffold::PluginInstallResult, String> {
    let dir = std::path::PathBuf::from(&made.dir);
    match unit_dev::set_source(ctx.identity().home(), kind, &made.dir_name, &dir) {
        Ok(_) => Ok(made),
        Err(e) => {
            // 선택되지 않은 반쪽 workspace 를 남기지 않는다.
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

fn dev_gate(ctx: &Ctx) -> Result<(), String> {
    unit_dev::ensure_dev_identity_build(&soksak_core::identity::core_build_for_identifier(
        ctx.identity().identifier(),
    ))
}

#[derive(serde::Deserialize)]
struct Id {
    id: String,
}

pub(crate) fn run_plugin_dev_new(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Id| {
        deny_without_write_ownership(ctx)?;
        dev_gate(ctx)?;
        let base = ctx.identity().path("workspaces/plugins");
        with_declaration(ctx, "plugin", soksak_scaffold::plugin_dev_new_in(&base, &a.id)?)
    })
}

#[derive(serde::Deserialize)]
struct Name {
    name: String,
}

pub(crate) fn run_plugin_dev_new2(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Name| {
        deny_without_write_ownership(ctx)?;
        dev_gate(ctx)?;
        let base = ctx.identity().path("workspaces/plugins");
        with_declaration(
            ctx,
            "plugin",
            soksak_scaffold::plugin_dev_new2_in(&base, &a.name)?,
        )
    })
}

#[derive(serde::Deserialize)]
struct Sidecar {
    name: String,
    #[serde(default)]
    interface: Option<String>,
}

pub(crate) fn run_sidecar_dev_new(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Sidecar| {
        deny_without_write_ownership(ctx)?;
        dev_gate(ctx)?;
        let base = ctx.identity().path("workspaces/plugins");
        with_declaration(
            ctx,
            "sidecar",
            soksak_scaffold::sidecar_dev_new_in(&base, &a.name, a.interface.as_deref())?,
        )
    })
}
