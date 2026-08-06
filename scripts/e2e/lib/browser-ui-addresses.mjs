function nodes(tree) {
  return Array.isArray(tree?.nodes) ? tree.nodes : [];
}

function exactlyOne(matches, description) {
  if (matches.length !== 1 || typeof matches[0]?.address !== "string") {
    throw new Error(`${description} 공개 주소는 정확히 하나여야 한다: ${matches.length}`);
  }
  return matches[0].address;
}

/** Resolve a browser-owned DOM node without depending on an adapter-specific nodePath prefix. */
export function browserTabNodeAddress(tree, tabId, role) {
  const tabToken = `/tab/${tabId}/`;
  const roleToken = `/${role}`;
  return exactlyOne(
    nodes(tree).filter((node) => node.address?.includes(tabToken)
      && (node.nodePath === role || node.nodePath?.endsWith(roleToken))),
    `탭 ${tabId}의 ${role}`,
  );
}

export function browserTabActivationAddress(tree, tabId) {
  return exactlyOne(
    nodes(tree).filter((node) => node.nodePath === `tab/view/${tabId}`),
    `탭 ${tabId}의 활성화 노드`,
  );
}
