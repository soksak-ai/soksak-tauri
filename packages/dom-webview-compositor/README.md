# DOM Webview Compositor

This package owns the framework-neutral contract between a DOM content slot and a native
webview surface. It defines logical/physical coordinate facts, composition samples,
transaction motion modes, and strict conformance verdicts.

It does not create browser product UI and does not name Tauri, Electron, a plugin, or an OS.
Platform adapters implement native view ownership separately. A platform is supported only
after its adapter passes the same conformance suite on that OS and display scale.

## Evidence rule

- Automated conformance consumes only finite transaction samples: public logical frames,
  scale factor, participant identity, phase, and sequence.
- Screen recordings are required development evidence and must be inspected by a person.
  Decoding a recording must never turn the automated conformance verdict green or red.
- A defect discovered in a recording is converted into a numeric transaction invariant before
  the implementation is changed. The same invariant proves RED and GREEN.
- Two producers' timestamps are comparable only inside one observation window. A producer whose
  samples do not intersect the declared transaction window is reported by its distance in
  milliseconds, never by a coordinate delta.

The package deliberately contains no transport. An in-process command adapter, Unix-domain
socket, Windows named pipe, or another transport may carry the same values without changing
the contract or verdict.

## Test ownership when extracted

- This package moves with its coordinate, rounding, transaction, stale-epoch, snap/glide, and
  conformance tests. Those tests accept adapter facts and never launch the soksak product.
- Each OS adapter owns integration tests for its native child-view API (AppKit/WKWebView,
  WebView2, or WebKitGTK) and must pass the shared conformance suite on every supported scale.
- The soksak repository keeps product E2E: the three browser implementations, sidebar/PIN and
  overlay layering, focus lighting, Korean IME, scrolling/full capture, and the Electron pure-DOM
  non-interference contract. macOS traffic-light cold-start, center, and titlebar-resize composition
  also remains a soksak framework/product E2E rather than moving into this DOM/webview package.
  Product policy therefore does not leak into the reusable compositor.
