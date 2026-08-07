import { must } from "./client.mjs";

const RELATION_NODE_PREFIX = "relation/rail/";

/** 공개 트리에서 결부 노드 하나를 집는다. 없으면 null — 이름으로 추측하지 않는다. */
export function findRelationNode(tree) {
  return (tree?.nodes ?? []).find((item) =>
    typeof item?.nodePath === "string" && item.nodePath.startsWith(RELATION_NODE_PREFIX)) ?? null;
}

/**
 * 한 시점의 PIN 기하를 공개면에서만 읽는다.
 *
 * 결부 노드 주소가 없으면 잴 자리가 없다 — 던진다. 노드가 답했는데 그린 상자를 안 실었다면
 * 그것은 값이다: evidence 로 그대로 흘러가 judge 가 이름을 붙인다. 두 경우를 한 throw 로
 * 뭉개면 계약 위반이 수치로 남지 않는다.
 *
 * surface rect 는 부르는 자리가 준 reader 가 해소한다 — 이 모듈은 어느 프레임워크인지 묻지 않는다.
 */
export async function readPinStage(rpc, win, stage, readSurfaceRect) {
  const tree = must(await rpc("ui.tree", { rects: true }, win), `${stage} ui.tree`);
  const relationNode = findRelationNode(tree);
  if (!relationNode?.address) {
    throw new Error(`${stage}: 결부 공개 노드 주소가 없다 — 보더를 잴 자리가 없다`);
  }
  const paneList = must(await rpc("pane.list", {}, win), `${stage} pane.list`);
  return {
    surfaceRect: await readSurfaceRect(tree),
    paneList,
    relationMeasure: relationNode,
  };
}
