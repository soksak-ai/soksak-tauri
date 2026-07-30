// 유닛 설치자 — 한 홈 트리에 대한 **단일 쓰기자**.
//
// 다섯 커맨드(begin·stage·read_utf8·commit·rollback)가 한 트랜잭션 원장을 공유한다.
// 원장은 프로세스 메모리에 있고(Mutex<HashMap>), 스테이징 디렉토리는 그 원장의 키로만
// 찾을 수 있다. 그래서 다섯은 **함께** 움직인다 — 하나만 떼면 남은 넷이 없는 원장을 본다.
//
// cored 프로세스로 나가려면 두 가지가 걸려 있었다:
//   ① 홈: lib.rs 가 앰비언트 전역(`home::soksak_home()`)을 읽어 생성자에 넣었고, 매니저는
//      그 값을 `join` 으로 네 곳에서 각각 조립했다. 정체성 계약(identity.rs)을 값으로 받으면
//      cored 는 인자 하나로 같은 홈을 쥐고, 조립 규칙은 `Identity::path` 한 곳에 모인다.
//   ② 입구: 다섯 입구가 `tauri::State` 를 받았다. State 를 요구하는 순간 원장째 앱
//      프로세스에 묶인다. 로직은 `&UnitInstallManager` 를 받는 함수로 내리고,
//      `#[tauri::command]` 는 State 를 벗겨 넘기는 번역층만 남긴다.
//
// 단일 쓰기자 계약은 그대로다. 같은 홈 트리를 두 프로세스가 쓰면 안 된다 — 원장의 의미도,
// commit 의 rename 원자성도 "이 트리를 쓰는 것은 나 하나"에 서 있다.

use soksak_core::artifact_integrity::verify_sha256;
use soksak_core::identity::Identity;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const INSTALL_STATE_SPEC: &str = "soksak-installed-units@0.0.1";
const MAX_READ_UTF8_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitIdentity {
    pub kind: String,
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageArtifact {
    pub url: String,
    pub sha256: String,
    pub format: String,
    pub entrypoints: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTransactionReply {
    pub transaction_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedArtifactReply {
    pub handle: String,
    pub sha256: String,
    pub extraction: &'static str,
    pub verified_entrypoints: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedInstallUnit {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub registry_id: String,
    pub source_repository: String,
    pub source_commit: String,
    pub release_tag: String,
    pub artifact_url: String,
    pub artifact_sha256: String,
    pub staged_handle: String,
    pub providers: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReply {
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledUnitReference {
    registry_id: String,
    kind: String,
    id: String,
    version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRootClosure {
    registry_id: String,
    root: UnitIdentity,
    units: Vec<InstalledUnitReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledUnit {
    #[serde(flatten)]
    release: VerifiedInstallUnit,
    generation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveInstallState {
    spec: String,
    current: String,
    previous: Option<String>,
    roots: Vec<InstalledRootClosure>,
    units: Vec<InstalledUnit>,
}

#[derive(Debug)]
struct StagedArtifact {
    identity: UnitIdentity,
    handle: String,
    path: PathBuf,
    url: String,
    sha256: String,
    entrypoints: Vec<String>,
}

#[derive(Debug)]
struct InstallTransaction {
    registry_id: String,
    root: UnitIdentity,
    path: PathBuf,
    staged: HashMap<String, StagedArtifact>,
}

#[derive(Debug)]
pub struct UnitInstallManager {
    identity: Identity,
    transactions: Mutex<HashMap<String, InstallTransaction>>,
}

fn validate_flat_id(label: &str, value: &str, extra: &[char]) -> Result<(), String> {
    let mut chars = value.chars();
    let head = chars
        .next()
        .is_some_and(|value| value.is_ascii_lowercase() || value.is_ascii_digit());
    let tail = chars.all(|value| {
        value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-' || extra.contains(&value)
    });
    if head && tail && value.len() <= 128 {
        Ok(())
    } else {
        Err(format!("invalid {label}: {value:?}"))
    }
}

fn validate_identity(identity: &UnitIdentity) -> Result<(), String> {
    if !matches!(identity.kind.as_str(), "plugin" | "sidecar" | "kit") {
        return Err(format!("invalid unit kind: {:?}", identity.kind));
    }
    validate_flat_id("unit id", &identity.id, &[])?;
    if !soksak_spec_contract::is_strict_semver(&identity.version) {
        return Err(format!("invalid unit version: {:?}", identity.version));
    }
    Ok(())
}

fn validate_registry_id(value: &str) -> Result<(), String> {
    validate_flat_id("registry id", value, &['.', '_'])?;
    if value.len() > 64 {
        return Err(format!("invalid registry id: {value:?}"));
    }
    Ok(())
}

fn canonical_uuid(label: &str, value: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| format!("invalid {label}: {value:?}"))?;
    if parsed.to_string() != value {
        return Err(format!("non-canonical {label}: {value:?}"));
    }
    Ok(())
}

fn reference(unit: &VerifiedInstallUnit) -> InstalledUnitReference {
    InstalledUnitReference {
        registry_id: unit.registry_id.clone(),
        kind: unit.kind.clone(),
        id: unit.id.clone(),
        version: unit.version.clone(),
    }
}

fn identity_key(kind: &str, id: &str) -> String {
    format!("{kind}\0{id}")
}

fn exact_reference_key(unit: &InstalledUnitReference) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        unit.registry_id, unit.kind, unit.id, unit.version
    )
}

fn validate_release_asset_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != raw
    {
        return Err("artifact URL must be a canonical credential-free GitHub Release URL".into());
    }
    let segments = url
        .path_segments()
        .ok_or("artifact URL has no path segments")?
        .collect::<Vec<_>>();
    if segments.len() != 6
        || segments[2] != "releases"
        || segments[3] != "download"
        || segments.iter().any(|segment| segment.is_empty())
    {
        return Err("artifact URL must identify one GitHub Release asset".into());
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_stage_artifact(artifact: &StageArtifact) -> Result<Vec<String>, String> {
    validate_release_asset_url(&artifact.url)?;
    if !matches!(artifact.format.as_str(), "tar.gz" | "tgz") {
        return Err("artifact format must be tar.gz or tgz".into());
    }
    if (artifact.format == "tar.gz" && !artifact.url.ends_with(".tar.gz"))
        || (artifact.format == "tgz" && !artifact.url.ends_with(".tgz"))
    {
        return Err("artifact format does not match its asset suffix".into());
    }
    let mut entrypoints = artifact.entrypoints.clone();
    entrypoints.sort();
    if entrypoints.is_empty() || entrypoints.iter().collect::<HashSet<_>>().len() != entrypoints.len() {
        return Err("artifact entrypoints must be non-empty and unique".into());
    }
    for entrypoint in &entrypoints {
        validate_archive_path(entrypoint)?;
    }
    Ok(entrypoints)
}

fn validate_verified_unit(unit: &VerifiedInstallUnit) -> Result<(), String> {
    validate_identity(&UnitIdentity {
        kind: unit.kind.clone(),
        id: unit.id.clone(),
        version: unit.version.clone(),
    })?;
    validate_registry_id(&unit.registry_id)?;
    validate_release_asset_url(&unit.artifact_url)?;
    if !valid_sha256(&unit.artifact_sha256) {
        return Err("artifact sha256 must be an exact lowercase digest".into());
    }
    canonical_uuid("staged handle", &unit.staged_handle)?;
    let source = url::Url::parse(&unit.source_repository).map_err(|error| error.to_string())?;
    if source.scheme() != "https"
        || source.host_str() != Some("github.com")
        || source.port().is_some()
        || !source.username().is_empty()
        || source.password().is_some()
        || source.query().is_some()
        || source.fragment().is_some()
        || source.as_str() != unit.source_repository
        || source.path_segments().map(|segments| segments.count()) != Some(2)
    {
        return Err("source repository must be a canonical GitHub repository URL".into());
    }
    if unit.source_commit.len() != 40
        || !unit
            .source_commit
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err("source commit must be an exact lowercase 40-character SHA".into());
    }
    Ok(())
}

fn validate_active_state(state: &ActiveInstallState) -> Result<(), String> {
    if state.spec != INSTALL_STATE_SPEC {
        return Err(format!("installed unit state requires {INSTALL_STATE_SPEC}"));
    }
    canonical_uuid("active generation", &state.current)?;
    if let Some(previous) = &state.previous {
        canonical_uuid("previous generation", previous)?;
        if previous == &state.current {
            return Err("active and previous generations must differ".into());
        }
    }

    let mut installed_by_exact = HashSet::new();
    let mut installed_by_identity = HashSet::new();
    for unit in &state.units {
        validate_verified_unit(&unit.release)?;
        canonical_uuid("unit generation", &unit.generation)?;
        if !installed_by_exact.insert(exact_reference_key(&reference(&unit.release)))
            || !installed_by_identity.insert(identity_key(&unit.release.kind, &unit.release.id))
        {
            return Err("installed unit identities must be unique".into());
        }
    }

    let mut roots = HashSet::new();
    let installed = state
        .units
        .iter()
        .map(|unit| exact_reference_key(&reference(&unit.release)))
        .collect::<HashSet<_>>();
    for closure in &state.roots {
        validate_registry_id(&closure.registry_id)?;
        validate_identity(&closure.root)?;
        if !roots.insert(identity_key(&closure.root.kind, &closure.root.id)) {
            return Err("installed roots must be unique".into());
        }
        if closure.units.is_empty() {
            return Err("installed root closure must be non-empty".into());
        }
        let mut closure_units = HashSet::new();
        for unit in &closure.units {
            validate_registry_id(&unit.registry_id)?;
            validate_identity(&UnitIdentity {
                kind: unit.kind.clone(),
                id: unit.id.clone(),
                version: unit.version.clone(),
            })?;
            if unit.registry_id != closure.registry_id {
                return Err("root closure cannot cross registry boundaries".into());
            }
            let exact = exact_reference_key(unit);
            if !closure_units.insert(exact.clone()) || !installed.contains(&exact) {
                return Err("root closure differs from installed unit evidence".into());
            }
        }
        let root = InstalledUnitReference {
            registry_id: closure.registry_id.clone(),
            kind: closure.root.kind.clone(),
            id: closure.root.id.clone(),
            version: closure.root.version.clone(),
        };
        if !closure_units.contains(&exact_reference_key(&root)) {
            return Err("installed root closure omits its root".into());
        }
    }
    if state.roots.is_empty() != state.units.is_empty() {
        return Err("installed roots and units must become empty together".into());
    }
    Ok(())
}

fn read_active_state(path: &Path) -> Result<Option<ActiveInstallState>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let state: ActiveInstallState = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            validate_active_state(&state)?;
            Ok(Some(state))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

// A plugin directory is a dev working copy when its state marker declares an
// unversioned source (`dev` scaffold or `local` build). Absent or release-versioned
// markers are installs the release channel owns and may replace.
fn is_dev_working_copy(dir: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(dir.join(".soksak.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    matches!(
        value.get("version").and_then(serde_json::Value::as_str),
        Some("dev") | Some("local")
    )
}

// Mark a published plugin as release-sourced so the loader and UI read a concrete
// version and its origin instead of treating it as a dev working copy.
fn write_release_state(dir: &Path, unit: &VerifiedInstallUnit) {
    let state = serde_json::json!({
        "version": unit.version,
        "repo": unit.source_repository,
        "releaseTag": unit.release_tag,
    });
    let _ = fs::write(
        dir.join(".soksak.json"),
        serde_json::to_string_pretty(&state).unwrap_or_default(),
    );
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("state path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    soksak_core::pathx::reject_symlink_components(parent)?;
    let temporary = parent.join(format!(".state-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            OpenOptions::new()
                .read(true)
                .open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

impl UnitInstallManager {
    /// 만들기만 한다. **비우지 않는다** — 생성이 파괴를 겸하면 두 번째로 만든 쪽이 남의
    /// 트랜잭션을 명령 이전에 지운다. 비우는 일은 부팅이 한 번, 이름을 달고 부른다
    /// (`clear_staging`).
    pub fn new(identity: Identity) -> Result<Self, String> {
        let home = identity.home();
        if !home.is_absolute() {
            return Err("unit installer home must be absolute".into());
        }
        fs::create_dir_all(home).map_err(|error| error.to_string())?;
        soksak_core::pathx::reject_symlink_components(home)?;
        let staging = identity.path("install-staging");
        fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        soksak_core::pathx::reject_symlink_components(&staging)?;
        Ok(Self { identity, transactions: Mutex::new(HashMap::new()) })
    }

    /// 스테이징 비우기 — 지난 실행이 남긴 미완 트랜잭션을 걷는다. **부팅에서 한 번만** 부른다:
    /// 도는 중에 부르면 남의 진행 중 트랜잭션이 사라진다.
    pub fn clear_staging(&self) -> Result<(), String> {
        let staging = self.identity.path("install-staging");
        for item in fs::read_dir(&staging).map_err(|error| error.to_string())? {
            let item = item.map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(item.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(item.path()).map_err(|error| error.to_string())?;
            } else if metadata.is_dir() {
                fs::remove_dir_all(item.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    /// 이 쓰기자가 쥔 정체성 — 어느 홈 트리를 쓰는지 읽을 수 있어야 단일 쓰기자를 확인한다.
    /// 앱 프로세스에는 아직 소비자가 없다(홈이 하나뿐이라 물을 일이 없었다). cored 가
    /// 붙는 순간 "네가 쓰는 홈이 어디냐"가 첫 질문이 되므로 상태면을 지금 연다.
    #[allow(dead_code)]
    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    fn staging_root(&self) -> PathBuf {
        self.identity.path("install-staging")
    }

    fn generations_root(&self) -> PathBuf {
        self.identity.path("unit-generations")
    }

    fn active_state_path(&self) -> PathBuf {
        self.identity.path("installed-units.json")
    }

    fn plugins_root(&self) -> PathBuf {
        self.identity.path("plugins")
    }

    // The plugin loader scans one directory: home/plugins/<id>. A dev working copy
    // there is owned by its author (spec §0-5) and must never be clobbered by a
    // release install. Refuse before any file moves so a rejected install leaves the
    // filesystem untouched. Only units staged in this generation are inspected; units
    // carried forward from a prior generation were published by their own commit.
    fn reject_dev_collisions(&self, state: &ActiveInstallState, generation: &str) -> Result<(), String> {
        let plugins_root = self.plugins_root();
        for unit in &state.units {
            if unit.release.kind != "plugin" || unit.generation != generation {
                continue;
            }
            let target = plugins_root.join(&unit.release.id);
            if is_dev_working_copy(&target) {
                return Err(format!(
                    "{} has a dev working copy at {} — remove it before installing the release",
                    unit.release.id,
                    target.display()
                ));
            }
        }
        Ok(())
    }

    // Publish each newly installed plugin unit to its single active location,
    // home/plugins/<id>. The generation store under unit-generations keeps the ledger;
    // the extracted files live at one stable path, never behind a UUID. Same filesystem,
    // so each swap is an atomic rename. Carried-forward units already sit at their path.
    fn publish_plugin_units(
        &self,
        generation_dir: &Path,
        state: &ActiveInstallState,
        generation: &str,
    ) -> Result<(), String> {
        let plugins_root = self.plugins_root();
        fs::create_dir_all(&plugins_root).map_err(|error| error.to_string())?;
        soksak_core::pathx::reject_symlink_components(&plugins_root)?;
        for unit in &state.units {
            if unit.release.kind != "plugin" || unit.generation != generation {
                continue;
            }
            let source = generation_dir.join(&unit.release.staged_handle);
            let target = plugins_root.join(&unit.release.id);
            soksak_core::pathx::reject_symlink_components(&source)?;
            if target.exists() {
                fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
            }
            fs::rename(&source, &target).map_err(|error| error.to_string())?;
            write_release_state(&target, &unit.release);
        }
        Ok(())
    }

    fn begin(&self, registry_id: String, root: UnitIdentity) -> Result<InstallTransactionReply, String> {
        validate_registry_id(&registry_id)?;
        validate_identity(&root)?;
        let transaction_id = uuid::Uuid::new_v4().to_string();
        let path = self.staging_root().join(&transaction_id);
        fs::create_dir(&path).map_err(|error| error.to_string())?;
        let transaction = InstallTransaction {
            registry_id,
            root,
            path,
            staged: HashMap::new(),
        };
        self.transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?
            .insert(transaction_id.clone(), transaction);
        Ok(InstallTransactionReply { transaction_id })
    }

    fn stage_bytes(
        &self,
        transaction_id: &str,
        registry_id: &str,
        unit: UnitIdentity,
        artifact: StageArtifact,
        body: &[u8],
    ) -> Result<StagedArtifactReply, String> {
        validate_identity(&unit)?;
        let entrypoints = validate_stage_artifact(&artifact)?;
        let mut transactions = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?;
        let transaction = transactions
            .get_mut(transaction_id)
            .ok_or("unit install transaction not found")?;
        if transaction.registry_id != registry_id {
            return Err("registry identity differs from transaction".into());
        }
        if transaction
            .staged
            .values()
            .any(|staged| staged.identity == unit)
        {
            return Err("unit release is already staged in this transaction".into());
        }
        let handle = uuid::Uuid::new_v4().to_string();
        let path = transaction.path.join(&handle);
        unpack_verify_install_entries(
            body,
            &artifact.sha256,
            &path,
            &entrypoints,
        )?;
        transaction.staged.insert(
            handle.clone(),
            StagedArtifact {
                identity: unit,
                handle: handle.clone(),
                path,
                url: artifact.url,
                sha256: artifact.sha256.clone(),
                entrypoints: entrypoints.clone(),
            },
        );
        Ok(StagedArtifactReply {
            handle,
            sha256: artifact.sha256,
            extraction: "regular-files-only",
            verified_entrypoints: entrypoints,
        })
    }

    fn read_utf8(&self, transaction_id: &str, handle: &str, path: &str) -> Result<String, String> {
        let relative = validate_archive_path(path)?;
        let transactions = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?;
        let transaction = transactions
            .get(transaction_id)
            .ok_or("unit install transaction not found")?;
        let staged = transaction.staged.get(handle).ok_or("staged artifact not found")?;
        let file_path = staged.path.join(relative);
        let metadata = fs::symlink_metadata(&file_path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("staged path is not a regular file".into());
        }
        if metadata.len() > MAX_READ_UTF8_BYTES {
            return Err(format!("staged text exceeds {MAX_READ_UTF8_BYTES} bytes"));
        }
        fs::read_to_string(file_path).map_err(|error| error.to_string())
    }

    fn validate_commit(
        transaction: &InstallTransaction,
        units: &[VerifiedInstallUnit],
    ) -> Result<(), String> {
        if units.len() != transaction.staged.len() || units.is_empty() {
            return Err("verified closure differs from staged artifact set".into());
        }
        let mut handles = HashSet::new();
        let mut identities = HashSet::new();
        for unit in units {
            let identity = UnitIdentity {
                kind: unit.kind.clone(),
                id: unit.id.clone(),
                version: unit.version.clone(),
            };
            validate_verified_unit(unit)?;
            if unit.registry_id != transaction.registry_id {
                return Err("verified unit registry differs from transaction".into());
            }
            if !handles.insert(unit.staged_handle.clone()) || !identities.insert(identity.clone()) {
                return Err("duplicate verified unit or staged handle".into());
            }
            let staged = transaction
                .staged
                .get(&unit.staged_handle)
                .ok_or("verified unit refers to an unknown staged handle")?;
            if staged.identity != identity
                || staged.handle != unit.staged_handle
                || staged.url != unit.artifact_url
                || staged.sha256 != unit.artifact_sha256
                || staged.entrypoints.is_empty()
            {
                return Err("verified unit evidence differs from staged artifact".into());
            }
        }
        let root_present = units.iter().any(|unit| {
            unit.kind == transaction.root.kind
                && unit.id == transaction.root.id
                && unit.version == transaction.root.version
        });
        if !root_present {
            return Err("verified closure omits the transaction root".into());
        }
        Ok(())
    }

    fn compose_state(
        transaction: &InstallTransaction,
        units: Vec<VerifiedInstallUnit>,
        generation: &str,
        prior: Option<ActiveInstallState>,
    ) -> Result<ActiveInstallState, String> {
        let root_key = identity_key(&transaction.root.kind, &transaction.root.id);
        let mut roots = prior
            .as_ref()
            .map(|state| state.roots.clone())
            .unwrap_or_default();
        roots.retain(|closure| identity_key(&closure.root.kind, &closure.root.id) != root_key);

        let mut closure_units = units.iter().map(reference).collect::<Vec<_>>();
        closure_units.sort();
        roots.push(InstalledRootClosure {
            registry_id: transaction.registry_id.clone(),
            root: transaction.root.clone(),
            units: closure_units,
        });
        roots.sort_by(|left, right| {
            (&left.root.kind, &left.root.id).cmp(&(&right.root.kind, &right.root.id))
        });

        let prior_current = prior.as_ref().map(|state| state.current.clone());
        let mut available = prior
            .map(|state| {
                state
                    .units
                    .into_iter()
                    .map(|unit| (exact_reference_key(&reference(&unit.release)), unit))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        for release in units {
            let installed = InstalledUnit {
                release,
                generation: generation.to_string(),
            };
            available.insert(
                exact_reference_key(&reference(&installed.release)),
                installed,
            );
        }

        let mut wanted_by_identity = HashMap::<String, InstalledUnitReference>::new();
        for closure in &roots {
            for unit in &closure.units {
                let key = identity_key(&unit.kind, &unit.id);
                if let Some(wanted) = wanted_by_identity.get(&key) {
                    if wanted != unit {
                        return Err(format!(
                            "installed roots require incompatible releases for {}:{}",
                            unit.kind, unit.id
                        ));
                    }
                } else {
                    wanted_by_identity.insert(key, unit.clone());
                }
            }
        }

        let mut installed = wanted_by_identity
            .values()
            .map(|wanted| {
                available
                    .remove(&exact_reference_key(wanted))
                    .ok_or_else(|| {
                        format!(
                            "installed evidence is missing for {}:{}@{}",
                            wanted.kind, wanted.id, wanted.version
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        installed.sort_by(|left, right| {
            (
                &left.release.kind,
                &left.release.id,
                &left.release.registry_id,
                &left.release.version,
            )
                .cmp(&(
                    &right.release.kind,
                    &right.release.id,
                    &right.release.registry_id,
                    &right.release.version,
                ))
        });

        let state = ActiveInstallState {
            spec: INSTALL_STATE_SPEC.to_string(),
            current: generation.to_string(),
            previous: roots
                .first()
                .and_then(|_| prior_current),
            roots,
            units: installed,
        };
        validate_active_state(&state)?;
        Ok(state)
    }

    fn commit(&self, transaction_id: &str, units: Vec<VerifiedInstallUnit>) -> Result<CommitReply, String> {
        let transaction = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?
            .remove(transaction_id)
            .ok_or("unit install transaction not found")?;
        if let Err(error) = Self::validate_commit(&transaction, &units) {
            self.transactions
                .lock()
                .map_err(|_| "unit installer lock poisoned".to_string())?
                .insert(transaction_id.to_string(), transaction);
            return Err(error);
        }
        let generation = uuid::Uuid::new_v4().to_string();
        let prior = match read_active_state(&self.active_state_path()) {
            Ok(value) => value,
            Err(error) => {
                self.transactions
                    .lock()
                    .map_err(|_| "unit installer lock poisoned".to_string())?
                    .insert(transaction_id.to_string(), transaction);
                return Err(error);
            }
        };
        let state = match Self::compose_state(&transaction, units, &generation, prior) {
            Ok(state) => state,
            Err(error) => {
                self.transactions
                    .lock()
                    .map_err(|_| "unit installer lock poisoned".to_string())?
                    .insert(transaction_id.to_string(), transaction);
                return Err(error);
            }
        };
        // Refuse a release that would clobber a dev working copy before touching any
        // active-state file — the staged transaction stays intact and rollback-able.
        if let Err(error) = self.reject_dev_collisions(&state, &generation) {
            self.transactions
                .lock()
                .map_err(|_| "unit installer lock poisoned".to_string())?
                .insert(transaction_id.to_string(), transaction);
            return Err(error);
        }
        let generations = self.generations_root();
        fs::create_dir_all(&generations).map_err(|error| error.to_string())?;
        soksak_core::pathx::reject_symlink_components(&generations)?;
        let destination = generations.join(&generation);
        fs::rename(&transaction.path, &destination).map_err(|error| error.to_string())?;
        let persist = write_json_atomic(&destination.join("generation.json"), &state)
            .and_then(|()| write_json_atomic(&self.active_state_path(), &state));
        if let Err(error) = persist {
            let restored = fs::rename(&destination, &transaction.path).is_ok();
            if restored {
                let _ = fs::remove_file(transaction.path.join("generation.json"));
                self.transactions
                    .lock()
                    .map_err(|_| "unit installer lock poisoned".to_string())?
                    .insert(transaction_id.to_string(), transaction);
            }
            return Err(error);
        }
        // Publish plugins to the loader's single active location. The dev-collision
        // gate above already cleared every target, so this only fails on IO.
        self.publish_plugin_units(&destination, &state, &generation)?;
        Ok(CommitReply { generation })
    }

    fn rollback(&self, transaction_id: &str) -> Result<(), String> {
        let transaction = self
            .transactions
            .lock()
            .map_err(|_| "unit installer lock poisoned".to_string())?
            .remove(transaction_id)
            .ok_or("unit install transaction not found")?;
        fs::remove_dir_all(transaction.path).map_err(|error| error.to_string())
    }
}

// ── 다섯 입구 ─────────────────────────────────────────────────────────────────
// 한 원장을 공유하는 다섯이다. 여기서는 `&UnitInstallManager` 만 받는다 — 호스트 타입이
// 시그니처에 없어야 cored 프로세스의 디스패처가 같은 다섯을 그대로 부를 수 있다.
// 아래 `#[tauri::command]` 는 State 를 벗겨 넘기는 번역층이다(로직을 두지 않는다).

pub fn install_begin(
    manager: &UnitInstallManager,
    registry_id: String,
    root: UnitIdentity,
) -> Result<InstallTransactionReply, String> {
    manager.begin(registry_id, root)
}

/// 자산을 받아 스테이징까지. 내려받기가 이 입구 안에 있어야 cored 가 커맨드 층 없이도
/// 같은 일을 한다 — 예전엔 이 한 줄이 `#[tauri::command]` 함수 몸통에만 있었다.
pub fn install_stage(
    manager: &UnitInstallManager,
    transaction_id: &str,
    registry_id: &str,
    unit: UnitIdentity,
    artifact: StageArtifact,
) -> Result<StagedArtifactReply, String> {
    let body = download_verified_bytes(&artifact.url, &artifact.sha256)?;
    install_stage_bytes(manager, transaction_id, registry_id, unit, artifact, &body)
}

/// 이미 손에 든 아티팩트 본문을 스테이징한다 — 내려받기 없이 스테이징만 검증할 때의 입구.
pub fn install_stage_bytes(
    manager: &UnitInstallManager,
    transaction_id: &str,
    registry_id: &str,
    unit: UnitIdentity,
    artifact: StageArtifact,
    body: &[u8],
) -> Result<StagedArtifactReply, String> {
    manager.stage_bytes(transaction_id, registry_id, unit, artifact, body)
}

pub fn install_read_utf8(
    manager: &UnitInstallManager,
    transaction_id: &str,
    handle: &str,
    path: &str,
) -> Result<String, String> {
    manager.read_utf8(transaction_id, handle, path)
}

pub fn install_commit(
    manager: &UnitInstallManager,
    transaction_id: &str,
    units: Vec<VerifiedInstallUnit>,
) -> Result<CommitReply, String> {
    manager.commit(transaction_id, units)
}

pub fn install_rollback(
    manager: &UnitInstallManager,
    transaction_id: &str,
) -> Result<(), String> {
    manager.rollback(transaction_id)
}
// ── 사이드카 아카이브 설치(fetch reach) ──────────────────────────────────────────────────────
// tmp 다운로드 → sha256 핀 → tar 해제 → entry 존재 확인 → 원자적 rename. 실패는 어느 단계든
// 목적지에 아무것도 남기지 않는다(download_verify 와 같은 무결성 우선 규칙).

pub fn download_unpack_verify(
    url: &str,
    sha256: &str,
    dest_dir: &Path,
    entry: &str,
) -> Result<(), String> {
    let body = download_verified_bytes(url, sha256)?;
    unpack_verify_install(&body, sha256, dest_dir, entry)
}

pub fn download_verified_bytes(url: &str, sha256: &str) -> Result<Vec<u8>, String> {
    let body = soksak_net::transport::honest_get_bytes(url)?;
    if body.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("archive 압축 크기 한도 초과: {MAX_ARCHIVE_BYTES}"));
    }
    verify_sha256(&body, sha256)?;
    Ok(body)
}

const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 20_000;
const MAX_ARCHIVE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES: usize = 512;

fn windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// One portable spelling for every archive path. No host normalization or filesystem lookup is
/// allowed to reinterpret an owner-provided name.
pub fn validate_archive_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > MAX_ARCHIVE_PATH_BYTES
        || path.starts_with('/')
        || path.starts_with('\\')
        || !path.is_ascii()
    {
        return Err(format!(
            "archive path가 portable relative ASCII 경로가 아닙니다: {path:?}"
        ));
    }
    let mut result = PathBuf::new();
    for segment in path.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.len() > 255
            || segment.ends_with(' ')
            || segment.ends_with('.')
            || windows_reserved_name(segment)
            || segment
                .bytes()
                .any(|byte| byte < 0x20 || byte == 0x7f || b"<>:\"\\|?*".contains(&byte))
        {
            return Err(format!("안전하지 않은 archive path segment: {segment:?}"));
        }
        result.push(segment);
    }
    if result.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir
        )
    }) {
        return Err(format!("archive path traversal 거부: {path:?}"));
    }
    Ok(result)
}

fn set_installed_mode(path: &Path, source_mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if source_mode & 0o111 == 0 {
            0o644
        } else {
            0o755
        };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = (path, source_mode);
    Ok(())
}

fn extract_regular_archive(body: &[u8], destination: &Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(body));
    let mut archive = tar::Archive::new(decoder);
    let mut paths = HashSet::new();
    let mut files = 0usize;
    let mut total_bytes = 0u64;

    let entries = archive
        .entries()
        .map_err(|e| format!("tar index 읽기 실패: {e}"))?;
    for item in entries {
        let mut entry = item.map_err(|e| format!("tar entry 읽기 실패: {e}"))?;
        let entry_type = entry.header().entry_type();
        // 디렉토리 엔트리는 구조 메타데이터다(관례적 tar 가 항상 싣는다) — 내용이 아니므로
        // 건너뛴다. 파일 경로 검증이 상위 디렉토리를 만들 때 동일 규칙을 이미 강제한다.
        // 심링크·하드링크·디바이스 등은 여전히 거부(정규 파일만 실체화).
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            let label = if entry_type.is_symlink() {
                "symlink"
            } else if entry_type.is_hard_link() {
                "hardlink"
            } else {
                "non-regular"
            };
            return Err(format!("archive {label} entry는 금지됩니다"));
        }
        files += 1;
        if files > MAX_ARCHIVE_FILES {
            return Err(format!("archive file 수 한도 초과: {MAX_ARCHIVE_FILES}"));
        }

        let raw_path = entry.path_bytes();
        let path_text = std::str::from_utf8(raw_path.as_ref())
            .map_err(|_| "archive path는 UTF-8이어야 합니다".to_string())?
            .to_owned();
        // 관례적 tar 는 엔트리를 "./name" 으로 싣는다 — 선두 "./" 는 구조 표기라 벗긴다.
        // 이후 검증은 그대로("."·".." 세그먼트·절대경로 전부 거부).
        let path_text = path_text
            .strip_prefix("./")
            .map(str::to_owned)
            .unwrap_or(path_text);
        let relative = validate_archive_path(&path_text)?;
        let portable_key = path_text.to_ascii_lowercase();
        if !paths.insert(portable_key) {
            return Err(format!("archive 중복/portable collision: {path_text}"));
        }

        let declared_size = entry.size();
        if declared_size > MAX_ARCHIVE_FILE_BYTES {
            return Err(format!("archive file 크기 한도 초과: {path_text}"));
        }
        total_bytes = total_bytes
            .checked_add(declared_size)
            .ok_or_else(|| "archive 전체 크기 overflow".to_string())?;
        if total_bytes > MAX_ARCHIVE_TOTAL_BYTES {
            return Err(format!(
                "archive 전체 크기 한도 초과: {MAX_ARCHIVE_TOTAL_BYTES}"
            ));
        }

        let output = destination.join(&relative);
        let parent = output
            .parent()
            .ok_or_else(|| format!("archive entry 상위 경로 없음: {path_text}"))?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        soksak_core::pathx::reject_symlink_components(parent)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|e| format!("archive entry 생성 실패 {path_text}: {e}"))?;
        let copied = std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("archive entry 쓰기 실패 {path_text}: {e}"))?;
        file.flush().map_err(|e| e.to_string())?;
        if copied != declared_size {
            return Err(format!(
                "archive entry 크기 불일치 {path_text}: 선언={declared_size} 실제={copied}"
            ));
        }
        let mode = entry.header().mode().map_err(|e| e.to_string())?;
        set_installed_mode(&output, mode)?;
    }
    if files == 0 {
        return Err("archive에 regular file이 없습니다".into());
    }
    Ok(())
}

// 순수부(네트워크 분리 — 유닛테스트 대상). dest_dir 이 이미 있으면 거부(멱등은 호출자가 entry
// 존재로 판정). tmp 는 dest 형제(같은 파일시스템 = rename 원자성 보장).
pub fn unpack_verify_install(
    body: &[u8],
    sha256: &str,
    dest_dir: &Path,
    entry: &str,
) -> Result<(), String> {
    unpack_verify_install_entries(body, sha256, dest_dir, &[entry.to_string()])
}

pub fn unpack_verify_install_entries(
    body: &[u8],
    sha256: &str,
    dest_dir: &Path,
    entries: &[String],
) -> Result<(), String> {
    if body.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("archive 압축 크기 한도 초과: {MAX_ARCHIVE_BYTES}"));
    }
    verify_sha256(body, sha256)?;
    if !dest_dir.is_absolute() {
        return Err(format!(
            "설치 목적지는 절대경로여야 합니다: {}",
            dest_dir.display()
        ));
    }
    if fs::symlink_metadata(dest_dir).is_ok() {
        return Err(format!("목적지 이미 존재: {}", dest_dir.display()));
    }
    let parent = dest_dir.parent().ok_or("목적지 부모 없음")?;
    soksak_core::pathx::reject_symlink_components(parent)?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    soksak_core::pathx::reject_symlink_components(parent)?;
    if entries.is_empty() {
        return Err("최소 한 개의 선언 entrypoint가 필요합니다".into());
    }
    let expected_entries = entries
        .iter()
        .map(|entry| validate_archive_path(entry))
        .collect::<Result<Vec<_>, _>>()?;
    if expected_entries.iter().collect::<HashSet<_>>().len() != expected_entries.len() {
        return Err("중복 선언 entrypoint는 금지됩니다".into());
    }
    let tmp_dir = parent.join(format!(".unpack-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&tmp_dir).map_err(|e| format!("임시 설치 디렉터리 생성 실패: {e}"))?;
    let extracted = extract_regular_archive(body, &tmp_dir).and_then(|()| {
        for (entry, expected_entry) in entries.iter().zip(expected_entries.iter()) {
            let installed_entry = tmp_dir.join(expected_entry);
            let metadata = fs::symlink_metadata(&installed_entry)
                .map_err(|_| format!("아카이브에 entry 없음: {entry}"))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(format!("아카이브 entry가 regular file이 아닙니다: {entry}"));
            }
        }
        Ok(())
    });
    if let Err(error) = extracted {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(error);
    }
    if let Err(error) = fs::rename(&tmp_dir, dest_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(format!("설치 rename 실패: {error}"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod archive_tests;

#[cfg(test)]
#[path = "lib_tests.rs"]
mod lib_tests;

/// 부팅에서 설치자를 세운다 — 만들고, **한 번** 비운다.
///
/// 생성이 비우기를 겸하면 두 번째로 만든 쪽이 남의 진행 중 트랜잭션을 명령 이전에 지운다.
/// 그래서 둘은 갈라져 있고, 이 함수가 "부팅"이라는 그 한 번을 이름으로 표시한다. 비우기가
/// 실패해도 설치자는 선다 — 지난 잔여가 남는 것은 다음 설치가 아니라 디스크의 문제다.
pub fn boot(identity: Identity) -> Result<UnitInstallManager, String> {
    let installer = UnitInstallManager::new(identity)?;
    if let Err(e) = installer.clear_staging() {
        eprintln!("[install] 스테이징 정리 실패: {e}");
    }
    Ok(installer)
}
