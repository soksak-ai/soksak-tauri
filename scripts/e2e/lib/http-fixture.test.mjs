// @vitest-environment node
import http from "node:http";
import { describe, expect, it } from "vitest";
import { closeHtmlFixture, startHtmlFixture } from "./http-fixture.mjs";

describe("브라우저 E2E fixture 서버 수명", () => {
  it("응답은 keep-alive를 남기지 않고 명시적 close로 완결된다", async () => {
    const fixture = await startHtmlFixture(() => "<!doctype html><title>fixture</title>");
    const response = await new Promise((resolve, reject) => {
      http.get(fixture.url, resolve).once("error", reject);
    });
    expect(response.headers.connection).toBe("close");
    response.resume();
    await closeHtmlFixture(fixture.server);
    expect(fixture.server.listening).toBe(false);
  });
});
