#!/usr/bin/env node
// 인수 실행 앞에 서서, 증거를 담을 자리가 없으면 실행을 시작조차 하지 않는다.
//
// 사용: node scripts/e2e/require-evidence-headroom.mjs --phase before-build --need 8
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { judgeHeadroom } from "./lib/evidence-headroom.mjs";

function readArg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

function readFreeGib(path) {
  try {
    const out = execFileSync("df", ["-g", path], { encoding: "utf8" });
    const fields = out.trim().split("\n").at(-1).split(/\s+/);
    return Number(fields[3]);
  } catch {
    // 못 읽음을 넉넉함으로 돌려주지 않는다 — judgeHeadroom 이 거절로 답한다.
    return Number.NaN;
  }
}

const phase = readArg("phase", "before-run");
const needGib = Number(readArg("need", "5"));
const verdict = judgeHeadroom({ freeGib: readFreeGib(homedir()), needGib, phase });

if (!verdict.ok) {
  console.error(verdict.message);
  process.exit(1);
}
