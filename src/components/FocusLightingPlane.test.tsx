// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusLightingPlane, type LightingRegion } from "./FocusLightingPlane";

const region = (id: string, left: number, moving = false): LightingRegion => ({
  id,
  moving,
  style: {
    "--l": `${left}%`,
    "--t": "0%",
    "--w": "50%",
    "--h": "100%",
  } as React.CSSProperties,
});

describe("FocusLightingPlane — 기본은 어둡고 포커스만 밝다", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("콘텐츠를 건드리지 않는 조명 평면 하나가 focus aperture를 뚫는다", async () => {
    await act(async () => {
      root.render(
        <FocusLightingPlane
          scopeId="space-a"
          baseAmount={0.5}
          focused={region("focused", 50, true)}
          blocked={[]}
        />,
      );
    });

    const plane = host.querySelector<SVGSVGElement>("[data-node='focus-lighting/space-a']");
    expect(plane).not.toBeNull();
    expect(plane?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("mask")?.getAttribute("data-node")).toBe(
      "focus-lighting/space-a/mask",
    );
    expect(host.querySelectorAll("[data-lighting-base]")).toHaveLength(1);
    expect(host.querySelector("[data-lighting-base]")?.getAttribute("data-node")).toBe(
      "focus-lighting/space-a/base",
    );
    expect(host.querySelector("[data-lighting-base]")?.getAttribute("fill-opacity")).toBe("0.5");

    const aperture = host.querySelector<SVGRectElement>("[data-lighting-aperture='focused']");
    expect(aperture).not.toBeNull();
    expect(aperture?.getAttribute("data-node")).toBe(
      "focus-lighting/space-a/aperture/focused",
    );
    expect(aperture?.classList.contains("flip-move")).toBe(true);
    expect(aperture?.style.getPropertyValue("--l")).toBe("50%");
  });

  it("blocked는 기본 veil에서 제외한 뒤 자기 농도로 한 번만 칠한다", async () => {
    await act(async () => {
      root.render(
        <FocusLightingPlane
          scopeId="space-b"
          baseAmount={0.5}
          focused={region("focused", 50)}
          blocked={[{ ...region("blocked", 0), amount: 0.7 }]}
        />,
      );
    });

    // mask의 blocked cutout이 base와 blocked veil의 중첩을 막는다. 0.5 위에 0.7을
    // 덧칠해 0.85가 되는 구현은 허용하지 않는다.
    expect(host.querySelectorAll("[data-lighting-cutout='blocked']")).toHaveLength(1);
    expect(
      host.querySelector("[data-lighting-cutout='blocked']")?.getAttribute("data-node"),
    ).toBe("focus-lighting/space-b/cutout/blocked");
    const blocked = host.querySelector<SVGRectElement>("[data-lighting-blocked='blocked']");
    expect(blocked?.getAttribute("data-node")).toBe(
      "focus-lighting/space-b/blocked/blocked",
    );
    expect(blocked?.getAttribute("fill-opacity")).toBe("0.7");
  });
});
