// 작업 공간 진단·복구 — 워크트리가 정본의 자원을 **공유하게** 세운다.
//
// git 워크트리는 추적 파일만 가진 빈 체크아웃으로 태어난다(`target/`·`node_modules/` 는 무시
// 대상이라 복원되지 않는다). 그래서 그 안에서 도구를 돌리면 도구가 **없는 것을 채운다** —
// cargo 는 처음부터 빌드하고, npm 은 Electron 을 다시 받는다. 워크트리 다섯이면 다섯 벌이다.
//
// 실사고(2026-07-29): 워크트리 다섯이 각자 전 워크스페이스를 빌드해 디스크가 100% 찼다.
// 그 뒤로 일어난 일은 전부 "빌드가 깨졌다"로 보였고 디스크로 보이지 않았다.
//   · Electron 번들의 `_CodeSignature` 가 잘려 macOS 가 앱 열기를 거부했다
//   · 워크트리의 `npm install` 이 잘려 `Electron Framework` 없는 껍데기 15벌이 남았다
//   · cargo 산출물이 잘려 검사가 무작위로 실패했다
//   · 셸 출력조차 ENOSPC 로 못 썼다
//
// 그래서 이 도구는 **멱등**하다. 몇 번을 돌려도 같은 상태로 수렴하고, 이미 정상이면 아무것도
// 하지 않는다. `--fix` 없이는 진단만 한다 — 지우는 것은 언제나 명시적이어야 한다.

import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");

/**
 * 병렬 빌드를 시작하기 전에 있어야 할 여유.
 *
 * 이 저장소의 전 워크스페이스 디버그 빌드는 17.5GiB 다(실측). 공유 target 을 쓰면 한 벌이면
 * 되지만, 처음 짓는 중이라면 그만큼이 필요하다. 그 아래에서 병렬 작업을 시작하면 위 사고가
 * 그대로 되풀이된다.
 */
export const MIN_FREE_GIB = 20;

const WORKTREES = ".claude/worktrees";
const ELECTRON_APP = "node_modules/electron/dist/Electron.app";
const ELECTRON_FRAMEWORK = `${ELECTRON_APP}/Contents/Frameworks/Electron Framework.framework/Electron Framework`;

/** 이 기계의 공유 target 설정. 절대경로여야 한다 — 상대경로면 워크트리마다 자기 아래로 풀린다. */
export function cargoConfigBody(root) {
  return `# 빌드 산출물은 **한 자리**에 모은다 — scripts/diag/workspace-doctor.mjs 가 만든다.
#
# 워크트리는 완전한 체크아웃이라 각자 \`target/\` 을 만든다. 이 저장소의 전 워크스페이스
# 디버그 빌드는 17.5GiB 라(실측) 워크트리 다섯이면 87GiB 가 되고, 그러면 디스크가 찬다.
#
# cargo 는 현재 디렉터리에서 위로 올라가며 config 를 찾는다. 워크트리가
# \`<repo>/${WORKTREES}/*\` 아래 있으므로 이 파일 하나가 그 전부에 미친다.
#
# **절대경로여야 한다.** 상대경로면 워크트리마다 자기 아래로 풀려 아무것도 공유되지 않는다.
# 그래서 기계별 설정이고 커밋하지 않는다(.gitignore). 다시 만들려면: make doctor-fix
#
# 대가: 같은 target 을 쓰는 빌드끼리 cargo 가 락으로 직렬화한다. 그 대신 컴파일된 의존성을
# 서로 재사용하므로 총 작업량은 훨씬 준다.
[build]
target-dir = "${join(root, "target")}"
`;
}

const gib = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** 이 볼륨의 여유. 못 재면 null — 못 잰 것과 넉넉한 것을 같게 보지 않는다. */
export function freeGiB(root = REPO_ROOT) {
  try {
    const out = execFileSync("df", ["-k", root], { encoding: "utf8" }).trim().split("\n").pop();
    const avail = Number(out.split(/\s+/)[3]);
    return Number.isFinite(avail) ? gib(avail * 1024) : null;
  } catch {
    return null;
  }
}

function worktreeDirs(root) {
  const base = join(root, WORKTREES);
  try {
    return readdirSync(base)
      .map((n) => join(base, n))
      .filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
}

/**
 * 진단만 한다 — 무엇이 어긋났고 왜 문제인지. 고치지 않는다.
 *
 * 각 항목은 `fix` 를 들고 있고 `--fix` 일 때만 그것이 돈다.
 */
export function diagnose(root = REPO_ROOT) {
  const findings = [];

  // ① 공유 target 설정이 있고 이 저장소를 가리키는가.
  const cfg = join(root, ".cargo/config.toml");
  const want = cargoConfigBody(root);
  const have = existsSync(cfg) ? readFileSync(cfg, "utf8") : null;
  if (have !== want) {
    findings.push({
      what: have === null ? "공유 target 설정이 없다" : "공유 target 설정이 이 저장소를 안 가리킨다",
      why: "워크트리마다 target 이 따로 나 디스크가 찬다(한 벌 17.5GiB)",
      fix: () => {
        mkdirSync(dirname(cfg), { recursive: true });
        writeFileSync(cfg, want);
      },
    });
  }

  // ② 정본 Electron 이 온전한가. 껍데기면 macOS 가 앱 열기를 거부한다.
  const fw = join(root, ELECTRON_FRAMEWORK);
  if (existsSync(join(root, ELECTRON_APP)) && !existsSync(fw)) {
    findings.push({
      what: "정본 Electron 에 Framework 가 없다",
      why: "설치가 중간에 잘렸다 — 앱이 DYLD 오류로 죽는다. 이것만은 자동으로 못 고친다",
      fix: null, // 재설치는 네트워크를 타므로 사람이 정한다.
      hint: "npm install electron --force",
    });
  }

  // ③ 워크트리가 자기 node_modules 를 갖고 있는가.
  //    Node 의 해석은 상위로 올라간다 — 워크트리에 없으면 정본을 쓴다. 있는 것은 `npm install`
  //    이 만든 사본이고, 디스크가 모자란 순간에 만들어졌으면 껍데기다.
  for (const w of worktreeDirs(root)) {
    const nm = join(w, "node_modules");
    if (!existsSync(nm)) continue;
    const whole = existsSync(join(w, ELECTRON_FRAMEWORK));
    findings.push({
      what: `${basename(w)}/node_modules ${whole ? "(온전)" : "(껍데기)"}`,
      why: whole
        ? "정본과 중복이다 — 상위 해석으로 정본을 쓰면 된다"
        : "Electron Framework 가 없다 — 이것을 실행하면 DYLD 오류로 죽는다",
      fix: () => rmSync(nm, { recursive: true, force: true }),
    });
  }

  // ④ 워크트리가 자기 target 을 갖고 있는가(①이 서기 전에 만들어진 것).
  for (const w of worktreeDirs(root)) {
    const t = join(w, "target");
    if (!existsSync(t)) continue;
    findings.push({
      what: `${basename(w)}/target`,
      why: "공유 target 이 서기 전에 만들어진 사본이다 — 지우면 다음 빌드가 정본 캐시를 쓴다",
      fix: () => rmSync(t, { recursive: true, force: true }),
    });
  }

  return findings;
}

/** 여유가 병렬 작업을 감당하는가. 못 잰 것은 넉넉함이 아니다. */
export function diskVerdict(root = REPO_ROOT, min = MIN_FREE_GIB) {
  const free = freeGiB(root);
  if (free === null) return { ok: false, free: null, why: "여유를 재지 못했다 — 넉넉하다고 보지 않는다" };
  if (free < min) return { ok: false, free, why: `여유 ${free}GiB < 기준 ${min}GiB` };
  return { ok: true, free, why: `여유 ${free}GiB` };
}

if (basename(process.argv[1] || "") === "workspace-doctor.mjs") {
  const fix = process.argv.includes("--fix");
  const disk = diskVerdict();
  console.log(`디스크: ${disk.ok ? "OK" : "부족"} — ${disk.why}`);

  const findings = diagnose();
  if (findings.length === 0) {
    console.log("작업 공간: 정상 — 고칠 것이 없다");
  } else {
    for (const f of findings) {
      const acted = fix && f.fix ? " → 고침" : "";
      console.log(`  ${fix && f.fix ? "✔" : "•"} ${f.what}${acted}`);
      console.log(`      ${f.why}`);
      if (!f.fix && f.hint) console.log(`      직접: ${f.hint}`);
      if (fix && f.fix) f.fix();
    }
    if (!fix) console.log("\n고치려면: make doctor-fix");
  }

  // 고친 뒤의 여유를 다시 말한다 — 고치기 전 숫자로 판단하면 방금 회수한 것이 안 보인다.
  if (fix) {
    const after = diskVerdict();
    console.log(`디스크(고친 뒤): ${after.ok ? "OK" : "부족"} — ${after.why}`);
    process.exitCode = after.ok ? 0 : 1;
  } else {
    process.exitCode = disk.ok && findings.length === 0 ? 0 : 1;
  }
}
