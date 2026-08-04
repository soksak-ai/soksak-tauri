import http from "node:http";

/**
 * 브라우저 E2E용 로컬 문서 서버. 응답 연결을 닫아 fixture 창 수명과 서버 수명이 결합되지 않게 한다.
 */
export function startHtmlFixture(render) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(render(request));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("fixture server address"));
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/** 서버가 소유한 연결까지 닫고 close 사건으로 완료한다. 무한 keep-alive 대기는 허용하지 않는다. */
export function closeHtmlFixture(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}
