//! Shared Vim word classes for the read-only transcript.
import { Navigation } from "./text.js";
const nav = new Navigation();
/** Grapheme-safe w/b/e destination. Borrows text. No null result. A host allocation failure throws. @param {string} text @param {number} at @param {-1 | 0 | 1} motion */
export function wordMotion(text, at, motion) {
  return motion < 0 ? nav.wordBack(text, at) : motion > 0 ? nav.wordEnd(text, at) : nav.wordStart(text, at);
}
/** Grapheme-safe W/B/E destination. Borrows text. No null result. A host allocation failure throws. @param {string} text @param {number} at @param {-1 | 0 | 1} motion */
export function wordBigMotion(text, at, motion) {
  return motion < 0 ? nav.wordBack(text, at, 1, true) : motion > 0 ? nav.wordEnd(text, at, 1, true) : nav.wordStart(text, at, 1, true);
}
