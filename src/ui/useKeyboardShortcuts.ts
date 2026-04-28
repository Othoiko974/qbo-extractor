import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';

// Shared keyboard-shortcut hook used across screens (Preview, Resolver,
// Review, Dashboard, Extraction). Listens at the window level and runs
// the matching handler. By default it skips events whose target is a
// text input / textarea / select / contenteditable — so typing in a
// search field never conflicts with a screen's own bindings.
//
// A second responsibility: every active binding is mirrored to a global
// registry so the macOS-style "hold ⌘" overlay can render the list of
// shortcuts available for the current screen. `label` is what shows in
// the overlay; `group` lets the overlay split bindings into sections
// (Navigation, Actions, …).

export type KeyBinding = {
  key: string; // e.g. "ArrowUp", "Enter", "Escape", "1", "r", " "
  meta?: boolean; // ⌘ on macOS, Ctrl on Windows/Linux
  shift?: boolean;
  alt?: boolean;
  // When true, fires even if a text input has focus. Use sparingly — Esc
  // is the typical case (close modal even from inside a search box).
  evenInInput?: boolean;
  handler: (e: KeyboardEvent) => void;
  // Defaults to true. preventDefault() stops native scrolling / form
  // submission; opt out with `false` for keys you also want to bubble.
  preventDefault?: boolean;
  // Human-readable description shown in the Cmd-hold overlay. Bindings
  // without a label are hidden from the overlay (still functional).
  label?: string;
  // Optional grouping label for the overlay (e.g. "Navigation", "Actions").
  group?: string;
};

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

// === Global registry ====================================================
// The active screen's bindings, mirrored here for the overlay to read.
// Only the most recent caller's bindings are kept — that matches the
// "current screen" mental model.

// Stable empty reference so useSyncExternalStore doesn't see a "change"
// every time we clear the registry (would otherwise loop on each
// mount/unmount cycle).
const EMPTY: KeyBinding[] = [];
let registry: KeyBinding[] = EMPTY;
const subscribers = new Set<() => void>();
function notify(): void {
  for (const cb of subscribers) cb();
}
function setRegistry(next: KeyBinding[]): void {
  const normalized = next.length === 0 ? EMPTY : next;
  if (normalized === registry) return;
  registry = normalized;
  notify();
}
function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
function getSnapshot(): KeyBinding[] {
  return registry;
}

export function useShortcutRegistry(): KeyBinding[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// === Hook ===============================================================

export function useKeyboardShortcuts(
  bindings: KeyBinding[],
  // Pass `false` to disable the listener (e.g. while a modal is up).
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    setRegistry(bindings);
    const onKey = (e: KeyboardEvent) => {
      const editable = isEditableTarget(e.target);
      for (const b of bindings) {
        if (b.key !== e.key) continue;
        if ((b.meta ?? false) !== (e.metaKey || e.ctrlKey)) continue;
        if ((b.shift ?? false) !== e.shiftKey) continue;
        if ((b.alt ?? false) !== e.altKey) continue;
        if (editable && !b.evenInInput) continue;
        if (b.preventDefault !== false) e.preventDefault();
        b.handler(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Only clear the registry if these bindings are still the ones
      // showing — avoids a flash when one screen replaces another's
      // bindings via a quick remount.
      if (registry === bindings) setRegistry([]);
    };
    // We deliberately depend only on `enabled` to keep the listener stable;
    // bindings are read on each event via closure so callers don't have to
    // memoize them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, bindings]);
}
