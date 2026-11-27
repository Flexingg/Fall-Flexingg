import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPress, HOLD_MS, isMenuKey, movedTooFar } from './longPress';

describe('long press', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens after the hold time, once', () => {
    const onOpen = vi.fn();
    const p = createLongPress({ onOpen });
    p.down(10, 10);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a short tap never opens', () => {
    const onOpen = vi.fn();
    const p = createLongPress({ onOpen });
    p.down(0, 0);
    vi.advanceTimersByTime(200);
    p.cancel();
    vi.advanceTimersByTime(1000);
    expect(onOpen).not.toHaveBeenCalled();
    expect(p.consumeClick()).toBe(false);
  });

  it('forgives a little movement but cancels when the finger wanders (a scroll)', () => {
    const onOpen = vi.fn();
    const p = createLongPress({ onOpen });
    p.down(100, 100);
    p.move(104, 103);
    vi.advanceTimersByTime(HOLD_MS);
    expect(onOpen).toHaveBeenCalledTimes(1);

    const q = createLongPress({ onOpen });
    q.down(100, 100);
    q.move(100, 130);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(q.pending).toBe(false);
  });

  it('swallows the click that ends a long press, and only that one', () => {
    const p = createLongPress({ onOpen: () => undefined });
    p.down(0, 0);
    vi.advanceTimersByTime(HOLD_MS);
    expect(p.consumeClick()).toBe(true);
    expect(p.consumeClick()).toBe(false);
  });

  it('opens from a right-click or the long-press menu without opening twice', () => {
    const onOpen = vi.fn();
    const p = createLongPress({ onOpen });
    p.openNow();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Android sends a contextmenu event right as the timer fires.
    p.down(0, 0);
    vi.advanceTimersByTime(HOLD_MS);
    p.openNow();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('measures movement and recognises the keyboard shortcuts', () => {
    expect(movedTooFar(0, 0, 6, 8)).toBe(false); // exactly 10
    expect(movedTooFar(0, 0, 8, 8)).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu' })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'F10' })).toBe(false);
    expect(isMenuKey({ key: 'Enter' })).toBe(false);
  });
});
