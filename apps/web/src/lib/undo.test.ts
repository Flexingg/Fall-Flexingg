import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachToastHost, type ToastState } from './toast';
import { deferAction, flushPending, isPendingUndo, UNDO_MS, undoAction } from './undo';

let toasts: (ToastState | null)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  toasts = [];
  attachToastHost((t) => toasts.push(t));
});
afterEach(async () => {
  await flushPending();
  attachToastHost(null);
  vi.useRealTimers();
});

describe('deferAction', () => {
  it('waits 5 seconds, then sends once', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn();
    deferAction({ key: 'a', message: 'Done', commit, settle });
    expect(isPendingUndo('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith();
    expect(isPendingUndo('a')).toBe(false);
  });

  it('shows a toast with an Undo button for the same time', () => {
    deferAction({ key: 'b', message: 'Left it', commit: async () => undefined });
    expect(toasts[0]).toMatchObject({ msg: 'Left it', duration: UNDO_MS });
    expect(toasts[0]?.action?.label).toBe('Undo');
  });

  it('never sends when undone', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    const settle = vi.fn();
    deferAction({ key: 'c', message: 'x', commit, settle });
    toasts[0]!.action!.onClick();
    expect(isPendingUndo('c')).toBe(false);
    expect(settle).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('flushes everything waiting right away', async () => {
    const one = vi.fn().mockResolvedValue(undefined);
    const two = vi.fn().mockResolvedValue(undefined);
    deferAction({ key: 'd1', message: 'x', commit: one });
    deferAction({ key: 'd2', message: 'x', commit: two });
    await flushPending();
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('reports a failed send to settle', async () => {
    const err = new Error('nope');
    const settle = vi.fn();
    deferAction({ key: 'e', message: 'x', commit: () => Promise.reject(err), settle });
    await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
    expect(settle).toHaveBeenCalledWith(err);
    expect(isPendingUndo('e')).toBe(false);
  });

  it('ignores the same key twice and undoing something that is not waiting', async () => {
    const commit = vi.fn().mockResolvedValue(undefined);
    deferAction({ key: 'f', message: 'x', commit });
    deferAction({ key: 'f', message: 'x', commit });
    undoAction('nothing');
    await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
