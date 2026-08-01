import { useCallback } from "react";
import { useSettings } from "./state/settings";
import { resolveText, type LocalizedText } from "./plugins/spec";

// 플러그인 텍스트(매니페스트 LocalizedText §3.5)를 현재 언어로 resolve.
// 호스트 i18n(키 테이블)과 별개 — 플러그인 텍스트의 소유자는 플러그인이고,
// 호스트는 현재 언어로 골라줄 뿐이다. 언어 변경 리렌더는 소비 컴포넌트의
// useT()/언어 구독이 담당(이 함수는 호출 시점 최신값을 읽는 순수 게터).
// 키 존재 여부(동적 키 소비자용 — 명령 라벨 cmd.* 조회 등). base(ko)가 커버리지의 기준이다.
export function hasMessage(key: string): boolean {
  return key in ko;
}

// 언어 패리티 게이트용(commandMessages.test) — 각 언어 테이블의 키 집합.
export function langKeySets(): { ko: string[]; en: string[] } {
  return { ko: Object.keys(ko), en: Object.keys(en) };
}

export function localize(t: LocalizedText): string {
  return resolveText(t, useSettings.getState().language);
}

// 비-React 번역(명령 message/speak 생성용) — useT 의 훅 밖 등가. 현재 대화 언어로 키를
// 해소하고 {placeholder} 를 params 로 채운다. 명령 응답 message 는 실행 시점(React 밖)에
// 지어지므로 이 함수를 쓴다. 언어별 문장은 키 테이블(아래 ko/en)이 단일 소유 — 언어 추가 =
// 테이블 열 추가(호출부 불변, P0). 커버리지는 commandMessages.test.ts 가 강제한다.
export function tmsg(key: MsgKey, params?: Record<string, string | number>): string {
  const lang = useSettings.getState().language;
  let s: string = messages[lang][key] ?? ko[key] ?? key;
  if (params) for (const k in params) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
}

// 간단한 i18n: 메시지 키 → 한/영. useT() 가 현재 언어로 번역 함수를 돌려준다.
// {name} 형태 플레이스홀더는 params 로 치환.

import { ko } from "./i18n.ko";
import { en } from "./i18n.en";

import type { MsgKey } from "./i18n.ko";
export type { MsgKey };


const messages = { ko, en };

export type TFn = (key: MsgKey, params?: Record<string, string | number>) => string;

// 현재 언어 기준 번역 함수. 언어가 바뀌면 구독 컴포넌트가 리렌더된다.
// 반환 함수는 언어가 같으면 참조가 안정(useCallback) — t 를 prop 으로 넘겨도
// React.memo 경계를 깨지 않는다(성능 헌법 원칙 2).
export function useT(): TFn {
  const lang = useSettings((s) => s.language);
  return useCallback<TFn>(
    (key, params) => {
      let s: string = messages[lang][key] ?? ko[key] ?? key;
      if (params) {
        for (const k in params) s = s.replace(`{${k}}`, String(params[k]));
      }
      return s;
    },
    [lang],
  );
}
