import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const EVIDENCE_RUN_LIMIT_BYTES = 1024 ** 3;
export const EVIDENCE_STORE_LIMIT_BYTES = 2 * EVIDENCE_RUN_LIMIT_BYTES;

const RUN_FILE = "run.json";
const BUCKETS = Object.freeze(["current", "last-red"]);
const RUN_STATUSES = new Set(["empty", "running", "red", "machine-green"]);
const STORE_TRANSACTIONS = new Map();
const EMPTY_RUN = Object.freeze({
  schemaVersion: 1,
  runId: null,
  status: "empty",
  keep: false,
});

export class EvidenceQuotaError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "EvidenceQuotaError";
    this.code = "EVIDENCE_QUOTA_EXCEEDED";
    this.details = details;
  }
}

function evidenceRoot(root) {
  if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) {
    throw new TypeError("증거 저장 root는 선언된 절대경로여야 한다");
  }
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError("파일시스템 root는 증거 저장 경계가 될 수 없다");
  }
  return resolved;
}

function inStoreTransaction(root, operation) {
  const key = evidenceRoot(root);
  const previous = STORE_TRANSACTIONS.get(key) ?? Promise.resolve();
  const transaction = previous.catch(() => undefined).then(operation);
  STORE_TRANSACTIONS.set(key, transaction);
  return transaction.finally(() => {
    if (STORE_TRANSACTIONS.get(key) === transaction) STORE_TRANSACTIONS.delete(key);
  });
}

function evidenceBucket(bucket) {
  if (!BUCKETS.includes(bucket)) {
    throw new TypeError(`알 수 없는 evidence bucket: ${String(bucket)}`);
  }
  return bucket;
}

export function evidenceStorePaths(root) {
  const resolved = evidenceRoot(root);
  return {
    root: resolved,
    current: path.join(resolved, "current"),
    lastRed: path.join(resolved, "last-red"),
  };
}

/**
 * 실패 회전의 모든 파괴/rename 표적을 파일시스템 접근 없이 확정한다.
 * 실행기는 이 계획과 정확히 같은 current/last-red만 변경한다.
 */
export function planFailedRunRotation(root) {
  const paths = evidenceStorePaths(root);
  return {
    root: paths.root,
    remove: paths.lastRed,
    rename: { from: paths.current, to: paths.lastRed },
    recreate: paths.current,
  };
}

function bucketPath(paths, bucket) {
  return bucket === "current" ? paths.current : paths.lastRed;
}

function assertExactBucketPath(paths, bucket, candidate) {
  const expected = bucketPath(paths, bucket);
  if (path.resolve(candidate) !== expected || path.dirname(expected) !== paths.root) {
    throw new Error(`증거 저장 경계 밖 변경 거부: ${candidate}`);
  }
  return expected;
}

export function resolveEvidenceFile(root, bucket, relativePath) {
  const paths = evidenceStorePaths(root);
  evidenceBucket(bucket);
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new TypeError("증거 파일은 비어 있지 않은 상대경로여야 한다");
  }
  if (path.isAbsolute(relativePath)) {
    throw new TypeError("증거 파일은 bucket 내부 상대경로여야 한다");
  }
  const normalized = path.normalize(relativePath);
  if (normalized === "."
      || normalized === ".."
      || normalized.startsWith(`..${path.sep}`)
      || normalized.includes("\0")) {
    throw new TypeError(`증거 파일 경계 이탈: ${relativePath}`);
  }
  if (normalized === RUN_FILE) {
    throw new TypeError(`${RUN_FILE}은 실행 상태 전용 예약 파일이다`);
  }
  const base = bucketPath(paths, bucket);
  const target = path.resolve(base, normalized);
  if (!target.startsWith(`${base}${path.sep}`)) {
    throw new TypeError(`증거 파일 경계 이탈: ${relativePath}`);
  }
  return target;
}

function isMissing(error) {
  return error && error.code === "ENOENT";
}

async function checkedStat(target) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink는 증거 저장소에 허용되지 않는다: ${target}`);
    }
    return stat;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function ensureDirectory(target, label) {
  const before = await checkedStat(target);
  if (before && !before.isDirectory()) {
    throw new Error(`${label}은 디렉터리여야 한다: ${target}`);
  }
  if (!before) await mkdir(target, { recursive: true });
  const after = await checkedStat(target);
  if (!after?.isDirectory()) {
    throw new Error(`${label} 디렉터리를 만들지 못했다: ${target}`);
  }
}

async function measureDirectory(directory) {
  const stat = await checkedStat(directory);
  if (!stat?.isDirectory()) throw new Error(`증거 bucket이 디렉터리가 아니다: ${directory}`);

  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const entryStat = await checkedStat(target);
    if (!entryStat) throw new Error(`증거 파일이 계측 중 사라졌다: ${target}`);
    if (entryStat.isDirectory()) bytes += await measureDirectory(target);
    else if (entryStat.isFile()) bytes += entryStat.size;
    else throw new Error(`일반 파일이 아닌 증거 항목은 허용되지 않는다: ${target}`);
  }
  return bytes;
}

function byteCount(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name}는 0 이상의 안전한 정수 byte여야 한다`);
  }
  return value;
}

function evidenceLimits(limits = {}) {
  const runLimitBytes = byteCount(
    "runLimitBytes",
    limits.runLimitBytes ?? EVIDENCE_RUN_LIMIT_BYTES,
  );
  const storeLimitBytes = byteCount(
    "storeLimitBytes",
    limits.storeLimitBytes ?? EVIDENCE_STORE_LIMIT_BYTES,
  );
  if (runLimitBytes === 0 || runLimitBytes > EVIDENCE_RUN_LIMIT_BYTES) {
    throw new TypeError("실행 한도는 1GiB hard cap보다 크거나 0일 수 없다");
  }
  if (storeLimitBytes === 0 || storeLimitBytes > EVIDENCE_STORE_LIMIT_BYTES) {
    throw new TypeError("전체 한도는 2GiB hard cap보다 크거나 0일 수 없다");
  }
  return { runLimitBytes, storeLimitBytes };
}

function quotaLabel(value, hardLimit, hardLabel) {
  return value === hardLimit ? hardLabel : `${value} bytes`;
}

/**
 * 쓰기 직전의 용량 판정을 순수 계산으로 제공한다. keep은 의도적으로 판정에 사용하지 않는다.
 */
export function projectEvidenceQuota({
  bucketBytes,
  otherBucketBytes,
  existingFileBytes,
  incomingBytes,
  keep: _keep = false,
  runLimitBytes = EVIDENCE_RUN_LIMIT_BYTES,
  storeLimitBytes = EVIDENCE_STORE_LIMIT_BYTES,
}) {
  const limits = evidenceLimits({ runLimitBytes, storeLimitBytes });
  const bucket = byteCount("bucketBytes", bucketBytes);
  const other = byteCount("otherBucketBytes", otherBucketBytes);
  const existing = byteCount("existingFileBytes", existingFileBytes);
  const incoming = byteCount("incomingBytes", incomingBytes);
  if (existing > bucket) {
    throw new TypeError("기존 파일 크기는 bucket 사용량보다 클 수 없다");
  }

  const projectedBucketBytes = bucket - existing + incoming;
  const projectedStoreBytes = projectedBucketBytes + other;
  const details = {
    bucketBytes: bucket,
    otherBucketBytes: other,
    existingFileBytes: existing,
    incomingBytes: incoming,
    projectedBucketBytes,
    projectedStoreBytes,
    ...limits,
  };
  if (projectedStoreBytes > limits.storeLimitBytes) {
    throw new EvidenceQuotaError(
      `증거 저장소 전체 ${quotaLabel(limits.storeLimitBytes, EVIDENCE_STORE_LIMIT_BYTES, "2GiB")} hard cap 초과`,
      details,
    );
  }
  if (projectedBucketBytes > limits.runLimitBytes) {
    throw new EvidenceQuotaError(
      `증거 실행당 ${quotaLabel(limits.runLimitBytes, EVIDENCE_RUN_LIMIT_BYTES, "1GiB")} hard cap 초과`,
      details,
    );
  }
  return details;
}

function validateRunId(runId) {
  if (typeof runId !== "string" || runId.trim().length === 0 || runId.length > 256) {
    throw new TypeError("runId는 1..256자의 비어 있지 않은 문자열이어야 한다");
  }
  return runId;
}

function validateRunState(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`잘못된 ${RUN_FILE}: ${source}`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "keep,runId,schemaVersion,status"
      || value.schemaVersion !== 1
      || !RUN_STATUSES.has(value.status)
      || typeof value.keep !== "boolean") {
    throw new Error(`잘못된 ${RUN_FILE} 계약: ${source}`);
  }
  if (value.status === "empty") {
    if (value.runId !== null || value.keep !== false) {
      throw new Error(`empty ${RUN_FILE}은 runId와 keep을 가질 수 없다: ${source}`);
    }
  } else {
    validateRunId(value.runId);
  }
  return {
    schemaVersion: 1,
    runId: value.runId,
    status: value.status,
    keep: value.keep,
  };
}

function runBytes(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

async function assertStoreLayout(paths) {
  const rootStat = await checkedStat(paths.root);
  if (!rootStat?.isDirectory()) throw new Error(`증거 저장 root가 디렉터리가 아니다: ${paths.root}`);
  const entries = (await readdir(paths.root)).sort();
  for (const entry of entries) {
    if (!BUCKETS.includes(entry)) {
      throw new Error(`timestamp archive/미등록 항목은 증거 저장 root에 허용되지 않는다: ${entry}`);
    }
  }
  for (const bucket of BUCKETS) {
    const target = bucketPath(paths, bucket);
    const stat = await checkedStat(target);
    if (!stat?.isDirectory()) throw new Error(`증거 bucket이 디렉터리가 아니다: ${target}`);
  }
}

async function existingFileSize(target) {
  const stat = await checkedStat(target);
  if (!stat) return 0;
  if (!stat.isFile()) throw new Error(`증거 대상은 일반 파일이어야 한다: ${target}`);
  return stat.size;
}

async function assertParentChain(bucket, targetParent) {
  const relative = path.relative(bucket, targetParent);
  if (relative === "" || relative === ".") return;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`증거 파일 부모 경계 이탈: ${targetParent}`);
  }
  let cursor = bucket;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = await checkedStat(cursor);
    if (!stat) return;
    if (!stat.isDirectory()) throw new Error(`증거 파일 부모가 디렉터리가 아니다: ${cursor}`);
  }
}

async function quotaBeforeWrite(paths, bucket, target, incomingBytes, options = {}) {
  const bucketRoot = bucketPath(paths, bucket);
  const otherRoot = bucketPath(paths, bucket === "current" ? "last-red" : "current");
  const [bucketBytes, otherBucketBytes, existingFileBytes] = await Promise.all([
    measureDirectory(bucketRoot),
    measureDirectory(otherRoot),
    existingFileSize(target),
  ]);
  return projectEvidenceQuota({
    bucketBytes,
    otherBucketBytes,
    existingFileBytes,
    incomingBytes,
    keep: options.keep,
    ...(options.limits ?? {}),
  });
}

async function writeManagedFile(paths, bucket, target, bytes, options = {}) {
  const base = bucketPath(paths, bucket);
  if (!target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`증거 저장 경계 밖 쓰기 거부: ${target}`);
  }
  await assertParentChain(base, path.dirname(target));
  const quota = await quotaBeforeWrite(paths, bucket, target, bytes.byteLength, options);
  await mkdir(path.dirname(target), { recursive: true });
  await assertParentChain(base, path.dirname(target));
  const targetStat = await checkedStat(target);
  if (targetStat && !targetStat.isFile()) {
    throw new Error(`증거 대상은 일반 파일이어야 한다: ${target}`);
  }
  await writeFile(target, bytes, { mode: 0o600 });
  return quota;
}

async function writeRunState(paths, bucket, state, options = {}) {
  const validated = validateRunState(state, `${bucket}/${RUN_FILE}`);
  const target = path.join(bucketPath(paths, bucket), RUN_FILE);
  return writeManagedFile(paths, bucket, target, runBytes(validated), options);
}

export async function ensureEvidenceStore(root) {
  const paths = evidenceStorePaths(root);
  await ensureDirectory(paths.root, "증거 저장 root");
  const entries = await readdir(paths.root);
  for (const entry of entries) {
    if (!BUCKETS.includes(entry)) {
      throw new Error(`timestamp archive/미등록 항목은 증거 저장 root에 허용되지 않는다: ${entry}`);
    }
  }
  for (const bucket of BUCKETS) {
    await ensureDirectory(bucketPath(paths, bucket), `증거 ${bucket} bucket`);
  }
  for (const bucket of BUCKETS) {
    const runFile = path.join(bucketPath(paths, bucket), RUN_FILE);
    const stat = await checkedStat(runFile);
    if (!stat) await writeRunState(paths, bucket, EMPTY_RUN);
    else if (!stat.isFile()) throw new Error(`${RUN_FILE}은 일반 파일이어야 한다: ${runFile}`);
    else await readEvidenceRun(paths.root, bucket);
  }
  await assertStoreLayout(paths);
  return inspectEvidenceStore(paths.root);
}

export async function readEvidenceRun(root, bucket) {
  const paths = evidenceStorePaths(root);
  evidenceBucket(bucket);
  const target = path.join(bucketPath(paths, bucket), RUN_FILE);
  const stat = await checkedStat(target);
  if (!stat?.isFile()) throw new Error(`${RUN_FILE}이 없다: ${target}`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`읽을 수 없는 ${RUN_FILE}: ${target}`, { cause: error });
  }
  return validateRunState(parsed, target);
}

export async function inspectEvidenceStore(root) {
  const paths = evidenceStorePaths(root);
  await assertStoreLayout(paths);
  const [currentBytes, lastRedBytes, currentRun, lastRedRun] = await Promise.all([
    measureDirectory(paths.current),
    measureDirectory(paths.lastRed),
    readEvidenceRun(paths.root, "current"),
    readEvidenceRun(paths.root, "last-red"),
  ]);
  return {
    root: paths.root,
    current: { path: paths.current, bytes: currentBytes, run: currentRun },
    lastRed: { path: paths.lastRed, bytes: lastRedBytes, run: lastRedRun },
    totalBytes: currentBytes + lastRedBytes,
  };
}

async function removeBucket(paths, bucket) {
  const target = assertExactBucketPath(paths, bucket, bucketPath(paths, bucket));
  await measureDirectory(target); // 삭제 전에 전체 트리를 읽어 symlink/특수 파일을 거부한다.
  await rm(target, { recursive: true });
}

async function resetBucket(paths, bucket) {
  await removeBucket(paths, bucket);
  await mkdir(assertExactBucketPath(paths, bucket, bucketPath(paths, bucket)));
}

async function beginEvidenceRunTransaction(root, { runId, keep = false, limits } = {}) {
  const id = validateRunId(runId);
  if (typeof keep !== "boolean") throw new TypeError("keep은 boolean이어야 한다");
  const paths = evidenceStorePaths(root);
  await ensureEvidenceStore(paths.root);
  const current = await readEvidenceRun(paths.root, "current");
  if (current.runId === id) return current;

  const lastRed = await readEvidenceRun(paths.root, "last-red");
  if (lastRed.runId === id && lastRed.status === "red") return lastRed;

  await resetBucket(paths, "current");
  const state = { schemaVersion: 1, runId: id, status: "running", keep };
  await writeRunState(paths, "current", state, { keep, limits });
  return state;
}

export function beginEvidenceRun(root, options = {}) {
  return inStoreTransaction(root, () => beginEvidenceRunTransaction(root, options));
}

function evidenceBytes(data) {
  if (typeof data === "string") return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("증거 내용은 string, Buffer 또는 Uint8Array여야 한다");
}

async function writeEvidenceFileTransaction(root, relativePath, data, options = {}) {
  const paths = evidenceStorePaths(root);
  await ensureEvidenceStore(paths.root);
  const current = await readEvidenceRun(paths.root, "current");
  if (current.status !== "running") {
    throw new Error(`running 실행만 증거를 쓸 수 있다: current=${current.status}`);
  }
  const target = resolveEvidenceFile(paths.root, "current", relativePath);
  return writeManagedFile(paths, "current", target, evidenceBytes(data), options);
}

export function writeEvidenceFile(root, relativePath, data, options = {}) {
  return inStoreTransaction(
    root,
    () => writeEvidenceFileTransaction(root, relativePath, data, options),
  );
}

async function finishEvidenceRunTransaction(root, { runId, status, limits } = {}) {
  const id = validateRunId(runId);
  if (status !== "machine-green" && status !== "red") {
    throw new TypeError("완료 status는 machine-green 또는 red여야 한다");
  }
  const paths = evidenceStorePaths(root);
  await ensureEvidenceStore(paths.root);
  const [current, lastRed] = await Promise.all([
    readEvidenceRun(paths.root, "current"),
    readEvidenceRun(paths.root, "last-red"),
  ]);

  if (status === "red" && lastRed.runId === id && lastRed.status === "red") {
    return { runId: id, status, rotated: false };
  }
  if (current.runId !== id) {
    throw new Error(`완료할 current 실행을 찾지 못했다: ${id}`);
  }
  if (current.status !== "running" && current.status !== status) {
    throw new Error(`실행 최종 상태를 ${current.status}에서 ${status}(으)로 바꿀 수 없다`);
  }

  const finalState = { ...current, status };
  if (current.status !== status) {
    await writeRunState(paths, "current", finalState, { keep: current.keep, limits });
  }
  if (status === "machine-green") return { runId: id, status, rotated: false };

  const plan = planFailedRunRotation(paths.root);
  assertExactBucketPath(paths, "last-red", plan.remove);
  assertExactBucketPath(paths, "current", plan.rename.from);
  assertExactBucketPath(paths, "last-red", plan.rename.to);
  assertExactBucketPath(paths, "current", plan.recreate);
  await removeBucket(paths, "last-red");
  await rename(plan.rename.from, plan.rename.to);
  await mkdir(plan.recreate);
  await writeRunState(paths, "current", EMPTY_RUN, { limits });
  return { runId: id, status, rotated: true };
}

export function finishEvidenceRun(root, options = {}) {
  return inStoreTransaction(root, () => finishEvidenceRunTransaction(root, options));
}
