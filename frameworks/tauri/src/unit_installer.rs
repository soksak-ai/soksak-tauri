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

use crate::identity::Identity;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
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
        crate::runtime_dep::validate_archive_path(entrypoint)?;
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
    crate::path_security::reject_symlink_components(parent)?;
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
    pub(crate) fn new(identity: Identity) -> Result<Self, String> {
        let home = identity.home();
        if !home.is_absolute() {
            return Err("unit installer home must be absolute".into());
        }
        fs::create_dir_all(home).map_err(|error| error.to_string())?;
        crate::path_security::reject_symlink_components(home)?;
        let staging = identity.path("install-staging");
        fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        crate::path_security::reject_symlink_components(&staging)?;
        for item in fs::read_dir(&staging).map_err(|error| error.to_string())? {
            let item = item.map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(item.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                fs::remove_file(item.path()).map_err(|error| error.to_string())?;
            } else if metadata.is_dir() {
                fs::remove_dir_all(item.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(Self { identity, transactions: Mutex::new(HashMap::new()) })
    }

    /// 이 쓰기자가 쥔 정체성 — 어느 홈 트리를 쓰는지 읽을 수 있어야 단일 쓰기자를 확인한다.
    /// 앱 프로세스에는 아직 소비자가 없다(홈이 하나뿐이라 물을 일이 없었다). cored 가
    /// 붙는 순간 "네가 쓰는 홈이 어디냐"가 첫 질문이 되므로 상태면을 지금 연다.
    #[allow(dead_code)]
    pub(crate) fn identity(&self) -> &Identity {
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
        crate::path_security::reject_symlink_components(&plugins_root)?;
        for unit in &state.units {
            if unit.release.kind != "plugin" || unit.generation != generation {
                continue;
            }
            let source = generation_dir.join(&unit.release.staged_handle);
            let target = plugins_root.join(&unit.release.id);
            crate::path_security::reject_symlink_components(&source)?;
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
        crate::runtime_dep::unpack_verify_install_entries(
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
        let relative = crate::runtime_dep::validate_archive_path(path)?;
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
        crate::path_security::reject_symlink_components(&generations)?;
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

pub(crate) fn install_begin(
    manager: &UnitInstallManager,
    registry_id: String,
    root: UnitIdentity,
) -> Result<InstallTransactionReply, String> {
    manager.begin(registry_id, root)
}

/// 자산을 받아 스테이징까지. 내려받기가 이 입구 안에 있어야 cored 가 커맨드 층 없이도
/// 같은 일을 한다 — 예전엔 이 한 줄이 `#[tauri::command]` 함수 몸통에만 있었다.
pub(crate) fn install_stage(
    manager: &UnitInstallManager,
    transaction_id: &str,
    registry_id: &str,
    unit: UnitIdentity,
    artifact: StageArtifact,
) -> Result<StagedArtifactReply, String> {
    let body = crate::runtime_dep::download_verified_bytes(&artifact.url, &artifact.sha256)?;
    install_stage_bytes(manager, transaction_id, registry_id, unit, artifact, &body)
}

/// 이미 손에 든 아티팩트 본문을 스테이징한다 — 내려받기 없이 스테이징만 검증할 때의 입구.
pub(crate) fn install_stage_bytes(
    manager: &UnitInstallManager,
    transaction_id: &str,
    registry_id: &str,
    unit: UnitIdentity,
    artifact: StageArtifact,
    body: &[u8],
) -> Result<StagedArtifactReply, String> {
    manager.stage_bytes(transaction_id, registry_id, unit, artifact, body)
}

pub(crate) fn install_read_utf8(
    manager: &UnitInstallManager,
    transaction_id: &str,
    handle: &str,
    path: &str,
) -> Result<String, String> {
    manager.read_utf8(transaction_id, handle, path)
}

pub(crate) fn install_commit(
    manager: &UnitInstallManager,
    transaction_id: &str,
    units: Vec<VerifiedInstallUnit>,
) -> Result<CommitReply, String> {
    manager.commit(transaction_id, units)
}

pub(crate) fn install_rollback(
    manager: &UnitInstallManager,
    transaction_id: &str,
) -> Result<(), String> {
    manager.rollback(transaction_id)
}

#[tauri::command]
pub fn unit_install_begin(
    manager: tauri::State<'_, UnitInstallManager>,
    registry_id: String,
    root: UnitIdentity,
) -> Result<InstallTransactionReply, String> {
    install_begin(manager.inner(), registry_id, root)
}

#[tauri::command]
pub fn unit_install_stage(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    registry_id: String,
    unit: UnitIdentity,
    artifact: StageArtifact,
) -> Result<StagedArtifactReply, String> {
    install_stage(
        manager.inner(),
        &transaction_id,
        &registry_id,
        unit,
        artifact,
    )
}

#[tauri::command]
pub fn unit_install_read_utf8(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    handle: String,
    path: String,
) -> Result<String, String> {
    install_read_utf8(manager.inner(), &transaction_id, &handle, &path)
}

#[tauri::command]
pub fn unit_install_commit(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
    units: Vec<VerifiedInstallUnit>,
) -> Result<CommitReply, String> {
    install_commit(manager.inner(), &transaction_id, units)
}

#[tauri::command]
pub fn unit_install_rollback(
    manager: tauri::State<'_, UnitInstallManager>,
    transaction_id: String,
) -> Result<(), String> {
    install_rollback(manager.inner(), &transaction_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

    fn home(name: &str) -> PathBuf {
        let base = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        let path = base.join(format!("soksak-unit-installer-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    // 테스트 홈은 dev identity 로 쥔다 — 홈과 identifier 는 함께 다닌다(identity.rs).
    fn installer(home: &Path) -> UnitInstallManager {
        UnitInstallManager::new(Identity::new(home, "com.soksak.dev")).unwrap()
    }

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (path, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(body.len() as u64);
            header.set_cksum();
            builder.append_data(&mut header, path, Cursor::new(*body)).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn digest(body: &[u8]) -> String {
        Sha256::digest(body).iter().map(|value| format!("{value:02x}")).collect()
    }

    fn identity() -> UnitIdentity {
        UnitIdentity { kind: "plugin".into(), id: "weather-plugin".into(), version: "0.0.1".into() }
    }

    fn artifact(sha256: String) -> StageArtifact {
        StageArtifact {
            url: "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.tgz".into(),
            sha256,
            format: "tgz".into(),
            entrypoints: vec!["plugin.json".into()],
        }
    }

    fn verified(handle: String, sha256: String) -> VerifiedInstallUnit {
        VerifiedInstallUnit {
            kind: "plugin".into(),
            id: "weather-plugin".into(),
            version: "0.0.1".into(),
            registry_id: "fixture".into(),
            source_repository: "https://github.com/example/weather-plugin".into(),
            source_commit: "a".repeat(40),
            release_tag: "v0.0.1".into(),
            artifact_url: "https://github.com/example/weather-plugin/releases/download/v0.0.1/weather-plugin-0.0.1.tgz".into(),
            artifact_sha256: sha256,
            staged_handle: handle,
            providers: Vec::new(),
        }
    }

    fn second_identity() -> UnitIdentity {
        UnitIdentity { kind: "plugin".into(), id: "notes-plugin".into(), version: "0.0.1".into() }
    }

    fn second_artifact(sha256: String) -> StageArtifact {
        StageArtifact {
            url: "https://github.com/example/notes-plugin/releases/download/v0.0.1/notes-plugin-0.0.1.tgz".into(),
            sha256,
            format: "tgz".into(),
            entrypoints: vec!["plugin.json".into()],
        }
    }

    fn second_verified(handle: String, sha256: String) -> VerifiedInstallUnit {
        VerifiedInstallUnit {
            kind: "plugin".into(),
            id: "notes-plugin".into(),
            version: "0.0.1".into(),
            registry_id: "fixture".into(),
            source_repository: "https://github.com/example/notes-plugin".into(),
            source_commit: "b".repeat(40),
            release_tag: "v0.0.1".into(),
            artifact_url: "https://github.com/example/notes-plugin/releases/download/v0.0.1/notes-plugin-0.0.1.tgz".into(),
            artifact_sha256: sha256,
            staged_handle: handle,
            providers: Vec::new(),
        }
    }

    #[test]
    fn the_installer_takes_an_identity_not_a_bare_home() {
        // 홈은 씨앗을 lib.rs 의 앰비언트 전역에서 받았고, 매니저 안에서는 join 으로 흩어졌다.
        // 정체성을 값으로 받으면 cored 프로세스가 인자 하나로 같은 홈을 쥔다.
        let root = home("identity");
        let id = crate::identity::Identity::new(root.clone(), "com.soksak.dev");
        let manager = UnitInstallManager::new(id.clone()).unwrap();
        assert_eq!(manager.identity(), &id);
        // 원장·세대·스테이징·발행 경로는 전부 이 정체성 아래다 — 단일 쓰기자 계약의 범위.
        assert_eq!(manager.active_state_path(), root.join("installed-units.json"));
        assert_eq!(manager.staging_root(), root.join("install-staging"));
        assert_eq!(manager.generations_root(), root.join("unit-generations"));
        assert_eq!(manager.plugins_root(), root.join("plugins"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_relative_home_is_refused_before_any_directory_is_made() {
        // 상대 홈은 cwd 상대로 트리를 만든다 — 그 트리는 어느 identity 홈도 아니다.
        let error = UnitInstallManager::new(crate::identity::Identity::new(
            "relative-home",
            "com.soksak.dev",
        ))
        .unwrap_err();
        assert!(error.contains("absolute"), "unexpected error: {error}");
        assert!(!Path::new("relative-home").exists());
    }

    #[test]
    fn the_five_transaction_entries_run_without_tauri_state() {
        // 커맨드 다섯이 한 원장을 공유한다. 그 아래 로직이 State 를 요구하면 원장째
        // 앱 프로세스에 묶인다 — &UnitInstallManager 만으로 다섯을 다 걷는다.
        let root = home("stateless");
        let manager =
            UnitInstallManager::new(crate::identity::Identity::new(root.clone(), "com.soksak.dev"))
                .unwrap();
        let transaction = install_begin(&manager, "fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#)]);
        let sha256 = digest(&body);
        let staged = install_stage_bytes(
            &manager,
            &transaction.transaction_id,
            "fixture",
            identity(),
            artifact(sha256.clone()),
            &body,
        )
        .unwrap();
        assert_eq!(
            install_read_utf8(&manager, &transaction.transaction_id, &staged.handle, "plugin.json")
                .unwrap(),
            r#"{"id":"weather-plugin"}"#
        );
        let committed = install_commit(
            &manager,
            &transaction.transaction_id,
            vec![verified(staged.handle, sha256)],
        )
        .unwrap();
        // 소비된 트랜잭션은 롤백할 것이 없다 — 원장이 하나임을 다섯 번째 입구로 확인한다.
        let error = install_rollback(&manager, &transaction.transaction_id).unwrap_err();
        assert!(error.contains("transaction not found"), "unexpected error: {error}");
        assert_eq!(
            read_active_state(&manager.active_state_path()).unwrap().unwrap().current,
            committed.generation
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commits_one_verified_generation_and_declares_the_active_absolute_root() {
        let home = home("commit");
        let manager = installer(&home);
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
        let sha256 = digest(&body);
        let staged = manager
            .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
            .unwrap();
        assert_eq!(
            manager.read_utf8(&transaction.transaction_id, &staged.handle, "plugin.json").unwrap(),
            r#"{"id":"weather-plugin"}"#
        );
        let committed = manager
            .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
            .unwrap();
        let active = read_active_state(&home.join("installed-units.json")).unwrap().unwrap();
        assert_eq!(active.current, committed.generation);
        assert!(home.join("unit-generations").join(&committed.generation).is_dir());
        assert!(!home.join("install-staging").join(&transaction.transaction_id).exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn publishes_the_committed_plugin_to_the_single_active_location() {
        let home = home("publish");
        let manager = installer(&home);
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
        let sha256 = digest(&body);
        let staged = manager
            .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
            .unwrap();
        manager
            .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
            .unwrap();
        // The loader scans home/plugins/<id>; the release must be published there, not
        // left behind a generation UUID.
        let published = home.join("plugins").join("weather-plugin");
        assert_eq!(
            fs::read_to_string(published.join("plugin.json")).unwrap(),
            r#"{"id":"weather-plugin"}"#
        );
        let state: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(published.join(".soksak.json")).unwrap()).unwrap();
        assert_eq!(state.get("version").and_then(|v| v.as_str()), Some("0.0.1"));
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn refuses_to_publish_over_a_dev_working_copy() {
        let home = home("dev-guard");
        let manager = installer(&home);
        // A dev author owns home/plugins/<id>; a release install must not clobber it.
        let dev = home.join("plugins").join("weather-plugin");
        fs::create_dir_all(&dev).unwrap();
        fs::write(dev.join(".soksak.json"), r#"{"version":"dev"}"#).unwrap();
        fs::write(dev.join("plugin.json"), r#"{"id":"weather-plugin","unsaved":true}"#).unwrap();
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#), ("main.js", b"export {}")]);
        let sha256 = digest(&body);
        let staged = manager
            .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256.clone()), &body)
            .unwrap();
        let error = manager
            .commit(&transaction.transaction_id, vec![verified(staged.handle, sha256)])
            .unwrap_err();
        assert!(error.contains("dev working copy"), "unexpected error: {error}");
        // The dev copy is untouched and no active state was advertised.
        assert_eq!(
            fs::read_to_string(dev.join("plugin.json")).unwrap(),
            r#"{"id":"weather-plugin","unsaved":true}"#
        );
        assert!(read_active_state(&home.join("installed-units.json")).unwrap().is_none());
        // The transaction stays rollback-able after the refusal.
        manager.rollback(&transaction.transaction_id).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn digest_failure_leaves_no_staged_unit_and_transaction_can_roll_back() {
        let home = home("digest");
        let manager = installer(&home);
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", b"{}")]);
        let error = manager
            .stage_bytes(
                &transaction.transaction_id,
                "fixture",
                identity(),
                artifact("0".repeat(64)),
                &body,
            )
            .unwrap_err();
        assert!(error.contains("sha256"));
        manager.rollback(&transaction.transaction_id).unwrap();
        assert!(!home.join("install-staging").join(&transaction.transaction_id).exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn commit_rejects_partial_evidence_without_consuming_the_transaction() {
        let home = home("partial");
        let manager = installer(&home);
        let transaction = manager.begin("fixture".into(), identity()).unwrap();
        let body = archive(&[("plugin.json", b"{}")]);
        let sha256 = digest(&body);
        manager
            .stage_bytes(&transaction.transaction_id, "fixture", identity(), artifact(sha256), &body)
            .unwrap();
        let error = manager.commit(&transaction.transaction_id, Vec::new()).unwrap_err();
        assert!(error.contains("closure"));
        manager.rollback(&transaction.transaction_id).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn independent_root_commits_preserve_both_verified_closures() {
        let home = home("multiple-roots");
        let manager = installer(&home);

        let first = manager.begin("fixture".into(), identity()).unwrap();
        let first_body = archive(&[("plugin.json", br#"{"id":"weather-plugin"}"#)]);
        let first_sha = digest(&first_body);
        let first_staged = manager
            .stage_bytes(&first.transaction_id, "fixture", identity(), artifact(first_sha.clone()), &first_body)
            .unwrap();
        manager
            .commit(&first.transaction_id, vec![verified(first_staged.handle, first_sha)])
            .unwrap();

        let second = manager.begin("fixture".into(), second_identity()).unwrap();
        let second_body = archive(&[("plugin.json", br#"{"id":"notes-plugin"}"#)]);
        let second_sha = digest(&second_body);
        let second_staged = manager
            .stage_bytes(
                &second.transaction_id,
                "fixture",
                second_identity(),
                second_artifact(second_sha.clone()),
                &second_body,
            )
            .unwrap();
        manager
            .commit(
                &second.transaction_id,
                vec![second_verified(second_staged.handle, second_sha)],
            )
            .unwrap();

        let active = read_active_state(&home.join("installed-units.json")).unwrap().unwrap();
        let ids = active.units.iter().map(|unit| unit.release.id.as_str()).collect::<HashSet<_>>();
        assert_eq!(ids, HashSet::from(["notes-plugin", "weather-plugin"]));
        fs::remove_dir_all(home).unwrap();
    }
}

// 이 코어 빌드가 실행 중인 호스트의 유닛 타깃 트리플. 설치 클로저가 sidecar 아티팩트를
// per-(os,arch) 자산에서 고르는 단일 기준이다 — 프론트가 플랫폼을 추측하지 않는다.
//
// 판정표는 코어가 소유하고 **타깃은 인자로** 넘긴다. 이 자리가 넘기는 값이 곧 이 실행물의
// 빌드 상수라, 답은 옛 cfg 분기와 같다. 표를 모르는 호스트는 그럴듯한 트리플을 지어내는
// 대신 이름을 달고 실패한다 — 지어내면 그 유닛은 받아서 못 돈다.
#[tauri::command]
pub fn host_unit_target() -> Result<&'static str, String> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    soksak_core::unit_target::host_target(os, arch)
        .ok_or_else(|| format!("유닛 타깃이 정의되지 않은 호스트다: {os}-{arch}"))
}
