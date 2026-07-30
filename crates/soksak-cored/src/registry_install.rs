//! 유닛 설치의 몸 — soksak-install 이 진다. 여기 있는 것은 배선뿐이다.
//!
//! 적혀 있던 벽 셋 중 둘이 사라졌다. ① "매니저 생성자가 파괴적이다" — 생성이 파괴를 겸하던
//! 것을 갈랐다(비우기는 부팅이 이름을 달고 한 번 부른다). ③ "원장이 프로세스 메모리라 begin 과
//! commit 을 다른 프로세스가 잡으면 뒤쪽은 실패뿐이다" — 다섯을 **함께** 옮기면 한 프로세스다.
//!
//! ② 는 남았고 여기서 그 자리를 밝힌다: 홈 트리에는 쓰기 소유권 표가 따로 없다. 오늘의
//! 단일 쓰기자 표는 저장소 잠금 하나뿐이라 그것으로 가른다 — 그 둘이 갈리는 날 이 게이트도
//! 함께 갈라야 한다.

use serde_json::Value;

use soksak_install::{
    install_begin, install_commit, install_read_utf8, install_rollback, install_stage,
    StageArtifact, UnitIdentity, UnitInstallManager, VerifiedInstallUnit,
};

use crate::ctx::Ctx;
use crate::registry::{dispatch, Outcome};
use crate::registry_store::deny_without_write_ownership;

/// 이 프로세스의 설치자 하나. 원장이 프로세스 메모리라 둘이면 begin 과 commit 이 갈린다.
fn manager(ctx: &Ctx) -> Result<&'static UnitInstallManager, String> {
    static M: std::sync::OnceLock<Result<UnitInstallManager, String>> = std::sync::OnceLock::new();
    M.get_or_init(|| UnitInstallManager::new(ctx.identity().clone()))
        .as_ref()
        .map_err(|e| e.clone())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Begin {
    registry_id: String,
    root: UnitIdentity,
}

pub(crate) fn run_unit_install_begin(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Begin| {
        deny_without_write_ownership(ctx)?;
        install_begin(manager(ctx)?, a.registry_id, a.root)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    transaction_id: String,
    registry_id: String,
    unit: UnitIdentity,
    artifact: StageArtifact,
}

pub(crate) fn run_unit_install_stage(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Stage| {
        deny_without_write_ownership(ctx)?;
        install_stage(
            manager(ctx)?,
            &a.transaction_id,
            &a.registry_id,
            a.unit,
            a.artifact,
        )
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadUtf8 {
    transaction_id: String,
    handle: String,
    path: String,
}

pub(crate) fn run_unit_install_read_utf8(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: ReadUtf8| {
        // 읽기다 — 쓰기 소유권을 요구하지 않는다. 다만 원장은 이 프로세스의 것이라, 남이 연
        // 트랜잭션은 여기서 못 읽는다(그 사실은 install_read_utf8 이 이름을 달고 말한다).
        install_read_utf8(manager(ctx)?, &a.transaction_id, &a.handle, &a.path)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Commit {
    transaction_id: String,
    units: Vec<VerifiedInstallUnit>,
}

pub(crate) fn run_unit_install_commit(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Commit| {
        deny_without_write_ownership(ctx)?;
        install_commit(manager(ctx)?, &a.transaction_id, a.units)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rollback {
    transaction_id: String,
}

pub(crate) fn run_unit_install_rollback(ctx: &Ctx, params: &Value) -> Outcome {
    dispatch(params, |a: Rollback| {
        deny_without_write_ownership(ctx)?;
        install_rollback(manager(ctx)?, &a.transaction_id)
    })
}
