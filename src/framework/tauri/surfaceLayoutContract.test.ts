import { describe, expect, it } from "vitest";
import { surfaceLayoutContractOf } from "./surfaceLayoutContract";

describe("Tauri native surface resize contract", () => {
  it("공개 grid 비율과 slot chrome을 새 viewport에 재투영할 계약으로 만든다", () => {
    const root = document.createElement("div");
    root.className = "space";
    const body = document.createElement("div");
    body.className = "tab-body";
    body.style.setProperty("--l", "66.6667%");
    body.style.setProperty("--t", "0%");
    body.style.setProperty("--w", "33.3333%");
    body.style.setProperty("--h", "50%");
    const slot = document.createElement("div");
    slot.setAttribute("data-content-view-body", "browser-a");
    body.appendChild(slot);
    root.appendChild(body);
    document.body.appendChild(root);

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
    root.getBoundingClientRect = () => ({
      x: 54, y: 82, width: 846, height: 998,
      top: 82, left: 54, right: 900, bottom: 1080, toJSON() {},
    });
    slot.getBoundingClientRect = () => ({
      x: 669, y: 177, width: 224, height: 374,
      top: 177, left: 669, right: 893, bottom: 551, toJSON() {},
    });

    expect(surfaceLayoutContractOf(slot)).toMatchObject({
      viewportW: 900,
      viewportH: 1080,
      rootX: 54,
      rootY: 82,
      rootW: 846,
      rootH: 998,
      leftRatio: 0.666667,
      topRatio: 0,
      widthRatio: 0.333333,
      heightRatio: 0.5,
      fixedX: expect.closeTo(51, 3),
      fixedY: 95,
      fixedW: expect.closeTo(-58, 3),
      fixedH: -125,
    });
  });

  it("공개 grid 계약이 없는 임의 element를 추측하지 않는다", () => {
    expect(surfaceLayoutContractOf(document.createElement("div"))).toBeNull();
  });
});
