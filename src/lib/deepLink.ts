// 딥링크 = command URI(`soksak://cmd/<command>?<params>`). 모든 기능이 command(단일 주소면)이므로
// 알림/외부 진입을 그대로 command 실행으로 라우팅한다(오픈·규칙화). 활성화 경로 3종(알림 클릭·액션
// 버튼·외부 soksak://)이 모두 이 해석기를 거친다. 권한·danger 게이트는 remote:true 로 유지 —
// 알림으로 권한 상승 불가(파괴적 command 는 설정 게이트를 동일하게 받음).

import { execute, type CommandContext, type CommandOutcome } from "../commands/registry";
import { invoke } from "../framework";

export interface DeepLink {
  command: string;
  params: Record<string, unknown>;
}

// 값 강제: JSON 으로 파싱되면 그 값(number/bool/object), 아니면 문자열 그대로.
function coerce(v: string): unknown {
  if (v === "") return "";
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** 이 제품의 명령 스킴인가 — 정체성 접미사를 받아들인다(`soksak:` · `soksak-dev:` …). */
function isCommandScheme(protocol: string): boolean {
  const s = protocol.replace(/:$/, "");
  return s === "soksak" || /^soksak-[a-z0-9]+$/.test(s);
}

// `soksak://cmd/<command>?<query>` → {command, params}. 형식 불일치/빈 command 는 null.
export function parseDeepLink(url: string): DeepLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // 스킴은 **정체성으로 갈린다**(`soksak` · `soksak-dev` · `soksak-debug`) — 한 스킴을 모든
  // 정체성이 주장하면 어느 앱이 그 링크를 받을지 제비뽑기가 된다(실측 2026-08-01: 이 기계에
  // `soksak:` 주장 번들이 200 개가 넘었다). 판정은 코어와 같다(soksak-core deeplink.rs
  // is_command_scheme) — 여기서 다르게 적으면 한쪽이 읽는 링크를 다른 쪽이 못 읽는다.
  if (!isCommandScheme(u.protocol) || u.host !== "cmd") return null;
  const command = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!command) return null;
  const params: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) params[k] = coerce(v);
  return { command, params };
}

// command + params → soksak:// URL(알림이 실어 보낼 딥링크 생성용). null/undefined 값은 생략.
export function buildDeepLink(
  command: string,
  params: Record<string, unknown> = {},
): string {
  const sp = new URLSearchParams();
  for (const [k, val] of Object.entries(params)) {
    if (val == null) continue;
    sp.set(k, typeof val === "string" ? val : JSON.stringify(val));
  }
  const q = sp.toString();
  return `soksak://cmd/${command}${q ? `?${q}` : ""}`;
}

// 딥링크 활성화 — 앱 전면 활성화 후 command 실행. deps 주입(테스트). remote:true 로 danger 게이트 유지.
export async function resolveDeepLink(
  url: string,
  deps: {
    execute: (
      name: string,
      params: Record<string, unknown>,
      ctx: CommandContext,
    ) => Promise<CommandOutcome>;
    activate: () => Promise<void>;
  } = {
    execute,
    activate: async () => {
      await invoke("window_activate");
    },
  },
): Promise<CommandOutcome> {
  const dl = parseDeepLink(url);
  if (!dl) {
    return { ok: false, code: "INVALID_PARAMS", message: `잘못된 딥링크: ${url}` };
  }
  await deps.activate();
  return deps.execute(dl.command, dl.params, { remote: true });
}
