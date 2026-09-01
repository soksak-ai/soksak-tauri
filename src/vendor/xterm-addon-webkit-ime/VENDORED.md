# IME input adapter

This module provides Korean and CJK composition input for the terminal surface on WKWebView.

## Input contract

- Standard composition events are handled by the terminal text-input owner.
- Replacement-text events are buffered and committed as one composed value.
- Partial Hangul input and duplicate commit events are suppressed once per composition.
- Backspace is delivered to the active composition owner exactly once.

## Change contract

Changes to `index.ts` must pass the Xterm 6 type boundary, composition-event tests, duplicate-input
tests, and the terminal integration checks in the same change.

## Known failing case

After a space, adding a final consonant can emit both the incomplete and complete syllable. The
reproduction is `있습니다`, `갔습니다`, or `했습니다` entered after a space. A native event trace
covering `beforeinput`, `input`, and terminal data delivery is required before changing the guards.
