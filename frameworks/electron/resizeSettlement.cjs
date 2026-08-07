// Electron 창 resize의 유한 거래.
//
// 거래가 settled가 되려면 ① 목표 크기의 BrowserWindow resize 사건(또는 명시적 no-op),
// ② 같은 거래 세대 안의 메인/보이는 guest presentation, ③ 각 NativeImage/dirtyRect와
// post-resize 실제 viewport 기하의 일치가 모두 필요하다. 픽셀 내용은 판정하지 않는다.

function namedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finiteSize(value, name) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw namedError("INVALID_RESIZE_SIZE", `${name} 크기가 유효하지 않다: ${JSON.stringify(value)}`);
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function finiteRect(value, name = "rect") {
  const result = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (
    !Object.values(result).every(Number.isFinite)
    || result.width < 0
    || result.height < 0
  ) {
    throw namedError("INVALID_PRESENTATION_GEOMETRY", `${name}가 유효하지 않다`);
  }
  return result;
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function contentsId(contents) {
  const id = Number(contents?.id);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw namedError("INVALID_WEB_CONTENTS", "presentation 대상 WebContents id가 없다");
  }
  return id;
}

function frameGeometry(event) {
  const image = event?.image;
  if (!image || image.isEmpty?.() || typeof image.getSize !== "function") {
    throw namedError("INVALID_PRESENTATION_FRAME", "presentation NativeImage 기하를 읽을 수 없다");
  }
  const frameSize = finiteSize(image.getSize(), "presentation frame");
  const dirtyRect = finiteRect(event.dirtyRect, "presentation dirtyRect");
  if (
    dirtyRect.width <= 0
    || dirtyRect.height <= 0
    || dirtyRect.x < 0
    || dirtyRect.y < 0
    || dirtyRect.x + dirtyRect.width > frameSize.width
    || dirtyRect.y + dirtyRect.height > frameSize.height
  ) {
    throw namedError(
      "INVALID_PRESENTATION_DIRTY_RECT",
      `dirtyRect가 frame 밖이다: frame=${JSON.stringify(frameSize)} dirty=${JSON.stringify(dirtyRect)}`,
    );
  }
  return { frameSize, dirtyRect };
}

function viewportSize(value, name) {
  const width = Number(value?.innerWidth);
  const height = Number(value?.innerHeight);
  const clientWidth = Number(value?.clientWidth);
  const clientHeight = Number(value?.clientHeight);
  const devicePixelRatio = Number(value?.devicePixelRatio);
  if (
    !(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    || !(Number.isFinite(clientWidth) && Number.isFinite(clientHeight))
    || !(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0)
  ) {
    throw namedError(
      "INVALID_PRESENTATION_GEOMETRY",
      `${name} viewport 기하가 유효하지 않다: ${JSON.stringify(value)}`,
    );
  }
  return { width, height, clientWidth, clientHeight, devicePixelRatio };
}

function createResizeSettlementLedger({ timeoutMs = 2_000, frameSubscriptions, displayGeometry } = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`resize settlement timeout이 유효하지 않다: ${timeoutMs}`);
  }
  if (!frameSubscriptions || typeof frameSubscriptions.acquire !== "function") {
    throw new TypeError("Electron frame subscription broker가 필요하다");
  }
  if (
    !displayGeometry
    || typeof displayGeometry.snapshot !== "function"
    || typeof displayGeometry.rectToPhysical !== "function"
    || typeof displayGeometry.physicalSizeToDip !== "function"
  ) {
    throw new TypeError("Electron display geometry adapter가 필요하다");
  }

  const states = new WeakMap();

  function stateFor(label, win) {
    let state = states.get(win);
    if (state) {
      if (state.label !== label) {
        throw namedError(
          "WINDOW_LABEL_MISMATCH",
          `같은 BrowserWindow가 두 label을 가리킨다: ${state.label}, ${label}`,
        );
      }
      return state;
    }
    state = {
      label,
      transactionGeneration: 0,
      resizeRevision: 0,
      settledRevision: 0,
      presentationRevisions: new Map(),
      pending: null,
      queue: [],
      running: false,
      last: null,
      lastResize: null,
    };
    states.set(win, state);
    win.on("resize", () => {
      state.resizeRevision += 1;
      const outerDip = finiteRect(win.getBounds(), "window bounds");
      const contentDip = finiteRect(win.getContentBounds(), "window content bounds");
      const pending = state.pending;
      const matchesPending = !!pending
        && outerDip.width === pending.requestedDip.width
        && outerDip.height === pending.requestedDip.height;
      state.lastResize = {
        revision: state.resizeRevision,
        source: matchesPending ? "transaction" : "external",
        transactionGeneration: matchesPending ? pending.transactionGeneration : null,
        outerDip,
        contentDip,
      };
      if (!matchesPending) return;
      pending.nativeSeen = true;
      pending.nativeRevision = state.resizeRevision;
      pending.actualOuter = outerDip;
      pending.actualContent = contentDip;
      pending.postDisplay = displayGeometry.snapshot(win, outerDip);
      pending.maybeFinish();
    });
    return state;
  }

  function targetList(win, surfaces) {
    const unique = [];
    const seen = new Set();
    const add = (contents, role) => {
      const id = contentsId(contents);
      if (seen.has(id)) return;
      seen.add(id);
      if (role === "surface" && typeof contents.executeJavaScript !== "function") {
        throw namedError(
          "SURFACE_GEOMETRY_UNAVAILABLE",
          `guest WebContents ${id}의 viewport 관측면이 없다`,
        );
      }
      unique.push({ contents, id, role, proof: null, checking: false, queuedEvent: null, mismatch: null });
    };
    add(win.webContents, "renderer");
    for (const contents of surfaces) add(contents, "surface");
    return unique;
  }

  async function expectedGeometry(target, pending, win) {
    if (target.role === "renderer") {
      const currentOuter = finiteRect(win.getBounds(), "window bounds");
      const currentContent = finiteRect(win.getContentBounds(), "window content bounds");
      if (!sameRect(currentOuter, pending.actualOuter) || !sameRect(currentContent, pending.actualContent)) {
        throw namedError(
          "RESIZE_GEOMETRY_CHANGED",
          `transaction ${pending.transactionGeneration} proof 중 창 기하가 다시 바뀌었다`,
        );
      }
      return {
        dip: { width: currentContent.width, height: currentContent.height },
        scaleFactor: pending.postDisplay.scaleFactor,
      };
    }
    const value = await target.contents.executeJavaScript(`(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      devicePixelRatio: window.devicePixelRatio
    }))()`);
    const viewport = viewportSize(value, `guest ${target.id}`);
    return {
      dip: { width: viewport.width, height: viewport.height },
      scaleFactor: viewport.devicePixelRatio,
    };
  }

  function receiptFor(state, win, pending, targets) {
    const outerConversion = displayGeometry.rectToPhysical(
      win,
      pending.actualOuter,
      pending.postDisplay,
    );
    const contentConversion = displayGeometry.rectToPhysical(
      win,
      pending.actualContent,
      pending.postDisplay,
    );
    const entry = (target) => ({
      webContentsId: target.id,
      presentationRevision: state.presentationRevisions.get(target.id) ?? 0,
      proof: target.proof,
    });
    return {
      framework: "electron",
      label: state.label,
      transactionGeneration: pending.transactionGeneration,
      status: "settled",
      changed: pending.changed,
      requested: {
        dip: pending.requestedDip,
        physical: pending.requestedPhysical,
        display: pending.preDisplay,
      },
      native: {
        resizeRevision: pending.nativeRevision,
        display: { pre: pending.preDisplay, post: pending.postDisplay },
        outerDip: pending.actualOuter,
        outerPhysicalSpace: outerConversion.coordinateSpace,
        outerPhysicalMethod: outerConversion.method,
        outerPhysical: outerConversion.rect,
        contentDip: pending.actualContent,
        contentPhysicalSpace: contentConversion.coordinateSpace,
        contentPhysicalMethod: contentConversion.method,
        contentPhysical: contentConversion.rect,
      },
      renderer: entry(targets[0]),
      surfaces: targets.slice(1).map(entry),
      settledRevision: state.settledRevision,
    };
  }

  function perform(state, job) {
    const { transactionGeneration, win, requestedPhysical, surfaces } = job;
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
      return Promise.reject(namedError("NO_WINDOW", `resize할 창이 없다: ${state.label}`));
    }
    const beforeOuter = finiteRect(win.getBounds(), "window bounds");
    const beforeContent = finiteRect(win.getContentBounds(), "window content bounds");
    const preDisplay = displayGeometry.snapshot(win, beforeOuter);
    const requestedDip = finiteSize(
      displayGeometry.physicalSizeToDip(requestedPhysical, preDisplay),
      "DIP",
    );
    const changed = beforeOuter.width !== requestedDip.width || beforeOuter.height !== requestedDip.height;
    let targets;
    try {
      targets = targetList(win, surfaces);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      let timer = null;
      const leases = [];
      const pending = {
        transactionGeneration,
        changed,
        requestedDip,
        requestedPhysical,
        preDisplay,
        postDisplay: changed ? null : preDisplay,
        nativeSeen: !changed,
        nativeRevision: state.resizeRevision,
        actualOuter: beforeOuter,
        actualContent: beforeContent,
        maybeFinish: () => {},
      };

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        for (const lease of leases) {
          try {
            lease.release();
          } catch {
            // 실제 proof/timeout 결과를 정리 예외로 바꾸지 않는다. broker 상태는 release 전에
            // 닫히므로 다른 lease를 끊지 않는다.
          }
        }
        if (state.pending?.transactionGeneration === transactionGeneration) state.pending = null;
      };

      const fail = (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };

      const maybeFinish = () => {
        if (finished || state.pending !== pending || !pending.nativeSeen) return;
        if (!pending.postDisplay || targets.some((target) => !target.proof)) return;
        if (targets.some((target) => (state.presentationRevisions.get(target.id) ?? 0) <= 0)) {
          fail(namedError(
            "PRESENTATION_REVISION_MISSING",
            `transaction ${transactionGeneration}에 revision 0인 presentation이 있다`,
          ));
          return;
        }
        finished = true;
        state.settledRevision += 1;
        const receipt = receiptFor(state, win, pending, targets);
        state.last = receipt;
        cleanup();
        resolve(receipt);
      };
      pending.maybeFinish = maybeFinish;
      state.pending = pending;

      const consumeFrames = async (target) => {
        if (target.checking || target.proof || finished) return;
        target.checking = true;
        try {
          while (target.queuedEvent && !target.proof && !finished) {
            const event = target.queuedEvent;
            target.queuedEvent = null;
            if (state.pending !== pending || !pending.nativeSeen) continue;
            try {
              const { frameSize, dirtyRect } = frameGeometry(event);
              const expected = await expectedGeometry(target, pending, win);
              if (state.pending !== pending || finished) return;
              const expectedPhysical = {
                width: Math.round(expected.dip.width * expected.scaleFactor),
                height: Math.round(expected.dip.height * expected.scaleFactor),
              };
              if (
                frameSize.width !== expectedPhysical.width
                || frameSize.height !== expectedPhysical.height
              ) {
                throw namedError(
                  "PRESENTATION_SIZE_MISMATCH",
                  `WebContents ${target.id} frame=${frameSize.width}x${frameSize.height}, ` +
                    `expected=${expectedPhysical.width}x${expectedPhysical.height} physical ` +
                    `(${expected.dip.width}x${expected.dip.height} DIP @${expected.scaleFactor})`,
                );
              }
              target.proof = {
                transactionGeneration,
                subscriptionGeneration: event.subscriptionGeneration,
                sequence: event.sequence,
                frameSize,
                dirtyRect,
                expectedDip: expected.dip,
                expectedPhysical,
                devicePixelRatio: expected.scaleFactor,
              };
              state.presentationRevisions.set(
                target.id,
                (state.presentationRevisions.get(target.id) ?? 0) + 1,
              );
              maybeFinish();
            } catch (error) {
              target.mismatch = `${error.code ?? "ERROR"}: ${error.message ?? error}`;
            }
          }
        } finally {
          target.checking = false;
          if (target.queuedEvent && !target.proof && !finished) void consumeFrames(target);
        }
      };

      try {
        for (const target of targets) {
          leases.push(frameSubscriptions.acquire(target.contents, (event) => {
            if (finished || state.pending !== pending || !pending.nativeSeen || target.proof) return;
            target.queuedEvent = event;
            void consumeFrames(target);
          }));
        }
        timer = setTimeout(() => {
          const missing = targets.filter((target) => !target.proof).map((target) => ({
            webContentsId: target.id,
            mismatch: target.mismatch,
          }));
          fail(namedError(
            "RESIZE_SETTLEMENT_TIMEOUT",
            `${state.label} resize transaction ${transactionGeneration}이 끝나지 않았다: ` +
              `native=${pending.nativeSeen}, presentation=${JSON.stringify(missing)}`,
          ));
        }, timeoutMs);
        if (changed) {
          win.setSize(requestedDip.width, requestedDip.height);
        } else {
          // no-op은 resize 사건이 없으므로 현재 실제 기하를 세대 기준으로 고정하고 새 frame을
          // 요구한다. 이전 receipt나 revision 0을 성공으로 재사용하지 않는다.
          for (const target of targets) {
            if (typeof target.contents.invalidate !== "function") {
              throw namedError(
                "PRESENTATION_INVALIDATE_UNAVAILABLE",
                `WebContents ${target.id}의 no-op presentation을 요구할 수 없다`,
              );
            }
            target.contents.invalidate();
          }
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  function drain(state) {
    if (state.running) return;
    const job = state.queue.shift();
    if (!job) return;
    state.running = true;
    perform(state, job).then(
      (value) => {
        // await한 호출자가 다음 요청을 넣는 시점에는 이전 거래 소유권이 이미 완전히 풀려 있어야
        // 한다. resolve 뒤 finally에 미루면 그 짧은 틈의 frame을 잃는다.
        state.running = false;
        job.resolve(value);
        drain(state);
      },
      (error) => {
        state.running = false;
        job.reject(error);
        drain(state);
      },
    );
  }

  function resize({ label, win, requestedPhysical: requestedInput, surfaces = [] }) {
    const requestedPhysical = finiteSize(requestedInput, "physical");
    const state = stateFor(String(label), win);
    state.transactionGeneration += 1;
    const transactionGeneration = state.transactionGeneration;
    return new Promise((resolve, reject) => {
      state.queue.push({ transactionGeneration, win, requestedPhysical, surfaces: [...surfaces], resolve, reject });
      drain(state);
    });
  }

  return {
    register: stateFor,
    resize,
    latest(label, win) {
      return stateFor(label, win).last;
    },
    observation(label, win) {
      const state = stateFor(label, win);
      return {
        label: state.label,
        resizeRevision: state.resizeRevision,
        settledRevision: state.settledRevision,
        pendingTransactionGeneration: state.pending?.transactionGeneration ?? null,
        queuedTransactionGenerations: state.queue.map((job) => job.transactionGeneration),
        lastResize: state.lastResize,
      };
    },
  };
}

module.exports = { createResizeSettlementLedger };
