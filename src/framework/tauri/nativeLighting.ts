import { invoke } from "@tauri-apps/api/core";
import { CONTENT_VIEW_BODY } from "../../lib/contentViews";
import { moduleState } from "../../lib/moduleState";

export type NativeLightingFact = { label: string; amount: number };
type SendLighting = (label: string, amount: number) => Promise<unknown>;

const clampAmount = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
};

/** 공개 DOM 계약을 native surface별 조명 사실로 읽는다. 플러그인 내부 DOM은 모른다. */
export function collectNativeLighting(doc: Document = document): NativeLightingFact[] {
  const facts = new Map<string, number>();
  for (const slot of doc.querySelectorAll<HTMLElement>(`[${CONTENT_VIEW_BODY}]`)) {
    const label = slot.getAttribute(CONTENT_VIEW_BODY);
    const body = slot.closest<HTMLElement>(".tab-body");
    if (!label || !body) continue;
    const amount = clampAmount(
      body.style.getPropertyValue("--dim") || getComputedStyle(body).getPropertyValue("--dim"),
    );
    facts.set(label, amount);
  }
  return [...facts].map(([label, amount]) => ({ label, amount }));
}

/** 같은 사실은 한 번만 보내고, DOM에서 사라진 surface의 native 조명은 반드시 clear한다. */
export function createNativeLightingSync(send: SendLighting) {
  let applied = new Map<string, number>();
  return async (doc: Document = document): Promise<void> => {
    const current = new Map(collectNativeLighting(doc).map((fact) => [fact.label, fact.amount]));
    const jobs: Promise<unknown>[] = [];
    for (const [label, amount] of current) {
      if (applied.get(label) !== amount) jobs.push(send(label, amount));
    }
    for (const label of applied.keys()) {
      if (!current.has(label)) jobs.push(send(label, 0));
    }
    await Promise.all(jobs);
    applied = current;
  };
}

const installed = moduleState("framework/tauri/nativeLighting#installed", () => ({
  on: false,
  observer: null as MutationObserver | null,
}));

/** React DOM 커밋의 attribute 변화만 구독한다. 주기 감시·bounds 추종은 하지 않는다. */
export function installNativeLighting(): void {
  if (installed.on || typeof document === "undefined") return;
  installed.on = true;
  const sync = createNativeLightingSync((label, amount) =>
    invoke("webview_dim", { label, amount }),
  );
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void sync().catch((error) => console.error("[tauri/native-lighting] sync failed", error));
    });
  };
  installed.observer = new MutationObserver(schedule);
  installed.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [CONTENT_VIEW_BODY, "data-dim", "style"],
  });
  schedule();
}

export function __resetNativeLightingForTest(): void {
  installed.observer?.disconnect();
  installed.observer = null;
  installed.on = false;
}
