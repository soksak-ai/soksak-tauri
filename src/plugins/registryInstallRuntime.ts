import { moduleState } from "../lib/moduleState";
import type {
  CertifiedRegistryIndex,
  RegistryUnitIdentity,
} from "./spec";

export interface RegistryInstallRuntimeInput {
  certified: CertifiedRegistryIndex;
  root: RegistryUnitIdentity;
}

export type RegistryInstallRuntimeResult =
  | { ok: true; id: string; version: string; generation: string }
  | { ok: false; code: string; message: string; errors?: string[] };

export type RegistryInstallRuntimeHandler = (
  input: RegistryInstallRuntimeInput,
) => Promise<RegistryInstallRuntimeResult>;

const unavailable: RegistryInstallRuntimeHandler = async () => ({
  ok: false,
  code: "INSTALL_RUNTIME_UNAVAILABLE",
  message: "the native atomic release installer is not available in this build",
});

// 주입점은 갈아끼우기 경계를 넘어야 한다 — 이 자리만 비면 채운 쪽은 이미 채웠다고 알고
// 다시 채우지 않는다. 그때 남는 것은 "아무도 답하지 않음"이고, 그 침묵은 오류가 아니다.
const handlerSlot = moduleState("plugins/registryInstallRuntime#handlerSlot.v", () => ({ v: unavailable }));
export function setRegistryInstallRuntime(
  next: RegistryInstallRuntimeHandler,
): () => void {
  const current = handlerSlot.v;
  handlerSlot.v = next;
  return () => {
    handlerSlot.v = current;
  };
}

export function installCertifiedRegistryUnit(
  input: RegistryInstallRuntimeInput,
): Promise<RegistryInstallRuntimeResult> {
  return handlerSlot.v(input);
}
