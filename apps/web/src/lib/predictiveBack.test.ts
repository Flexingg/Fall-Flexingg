import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backHandlerCount,
  backTarget,
  backVersion,
  canGoBackInApp,
  clamp01,
  dialogFrame,
  edgeOf,
  pageFrame,
  registerBackHandler,
  sheetFrame,
  subscribeBack,
  topBackHandler,
  wantsBack,
} from './predictiveBack';

const offs: Array<() => void> = [];
afterEach(() => {
  offs.splice(0).forEach((f) => f());
});
const add = (name: string, kind: 'sheet' | 'dialog' = 'sheet') => {
  const close = vi.fn();
  offs.push(registerBackHandler({ kind, close }));
  return { name, close };
};

describe('back handler stack', () => {
  it('the most recently opened sheet is on top', () => {
    const a = add('a');
    const b = add('b');
    expect(backHandlerCount()).toBe(2);
    topBackHandler()?.close();
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
  });

  it('closing the top one uncovers the one below', () => {
    const a = add('a');
    const off = registerBackHandler({ kind: 'dialog', close: vi.fn() });
    expect(topBackHandler()?.kind).toBe('dialog');
    off();
    topBackHandler()?.close();
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it('removes a handler from the middle without disturbing the rest', () => {
    const a = add('a');
    const offB = registerBackHandler({ kind: 'sheet', close: vi.fn() });
    const c = add('c');
    offB();
    expect(backHandlerCount()).toBe(2);
    topBackHandler()?.close();
    expect(c.close).toHaveBeenCalled();
    expect(a.close).not.toHaveBeenCalled();
  });

  it('tells listeners and bumps the version when it changes', () => {
    const seen = vi.fn();
    const stop = subscribeBack(seen);
    const v = backVersion();
    const off = registerBackHandler({ kind: 'sheet', close: vi.fn() });
    off();
    off(); // taking it off twice is harmless
    stop();
    expect(seen).toHaveBeenCalledTimes(3);
    expect(backVersion()).toBeGreaterThan(v);
    expect(backHandlerCount()).toBe(0);
  });
});

describe('what back should do', () => {
  it('stays off at the root so Android plays its own back-to-home animation', () => {
    expect(wantsBack(0, false)).toBe(false);
  });
  it('is on when a sheet is open or there is a page to go back to', () => {
    expect(wantsBack(1, false)).toBe(true);
    expect(wantsBack(0, true)).toBe(true);
  });
  it('reads the position in the app history from React Router', () => {
    expect(canGoBackInApp({ idx: 0 })).toBe(false);
    expect(canGoBackInApp({ idx: 2 })).toBe(true);
    expect(canGoBackInApp(null)).toBe(false);
    expect(canGoBackInApp({})).toBe(false);
  });
  it('closes a sheet before it leaves the page', () => {
    expect(backTarget({ kind: 'sheet', close: () => undefined }, true)).toBe('sheet');
    expect(backTarget({ kind: 'dialog', close: () => undefined }, false)).toBe('dialog');
    expect(backTarget(undefined, true)).toBe('page');
    expect(backTarget(undefined, false)).toBe('none');
  });
  it('reads the swipe edge', () => {
    expect(edgeOf(0)).toBe('left');
    expect(edgeOf(1)).toBe('right');
    expect(edgeOf(undefined)).toBe('left');
  });
});

describe('animation frames', () => {
  it('clamps progress', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
  it('a page starts untouched and ends about 90% size', () => {
    const f0 = pageFrame(0, 'left');
    expect(f0).toEqual({ scale: 1, shiftX: 0, radius: 0, dim: 0 });
    const f1 = pageFrame(1, 'left');
    expect(f1.scale).toBeCloseTo(0.9);
    expect(f1.radius).toBeGreaterThan(0);
    expect(f1.dim).toBeGreaterThan(0);
  });
  it('a page shifts away from the edge the finger came from', () => {
    expect(pageFrame(1, 'left').shiftX).toBeGreaterThan(0);
    expect(pageFrame(1, 'right').shiftX).toBeLessThan(0);
  });
  it('rounds the corners early, then holds', () => {
    expect(pageFrame(0.25, 'left').radius).toBe(pageFrame(1, 'left').radius);
  });
  it('a sheet sinks and shrinks, capped for tall sheets, and its backdrop fades', () => {
    expect(sheetFrame(0, 400)).toEqual({ scale: 1, translateY: 0, dim: 1 });
    const f = sheetFrame(1, 400);
    expect(f.scale).toBeLessThan(1);
    expect(f.translateY).toBe(120);
    expect(f.dim).toBe(0);
    expect(sheetFrame(1, 2000).translateY).toBe(160);
    expect(sheetFrame(0.5, 400).dim).toBe(0.5);
  });
  it('a dialog shrinks and fades', () => {
    expect(dialogFrame(0)).toEqual({ scale: 1, opacity: 1 });
    expect(dialogFrame(1).scale).toBeCloseTo(0.9);
    expect(dialogFrame(1).opacity).toBeLessThan(1);
  });
});
