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

The package deliberately contains no transport. An in-process command adapter, Unix-domain
socket, Windows named pipe, or another transport may carry the same values without changing
the contract or verdict.
