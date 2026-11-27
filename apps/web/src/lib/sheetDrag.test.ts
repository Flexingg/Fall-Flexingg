import { describe, expect, it } from 'vitest';
import { dimAmount, dragIntent, followY, nextVelocity, shouldClose } from './sheetDrag';

describe('dragIntent', () => {
  it('waits until the finger has moved a little', () => {
    expect(dragIntent({ dx: 1, dy: 2, fromHandle: false, scrollTop: 0 })).toBe('pending');
    expect(dragIntent({ dx: 0, dy: 2, fromHandle: true, scrollTop: 0 })).toBe('pending');
  });
  it('always drags down from the handle, even sideways-ish or scrolled', () => {
    expect(dragIntent({ dx: 30, dy: 8, fromHandle: true, scrollTop: 400 })).toBe('drag');
  });
  it('does not drag up from the handle', () => {
    expect(dragIntent({ dx: 0, dy: -20, fromHandle: true, scrollTop: 0 })).toBe('pending');
  });
  it('drags from the body only at the top of the scroll and downward', () => {
    expect(dragIntent({ dx: 2, dy: 20, fromHandle: false, scrollTop: 0 })).toBe('drag');
    expect(dragIntent({ dx: 2, dy: 20, fromHandle: false, scrollTop: 120 })).toBe('ignore');
    expect(dragIntent({ dx: 2, dy: -20, fromHandle: false, scrollTop: 0 })).toBe('ignore');
  });
  it('leaves sideways swipes alone', () => {
    expect(dragIntent({ dx: 40, dy: 12, fromHandle: false, scrollTop: 0 })).toBe('ignore');
  });
});

describe('shouldClose', () => {
  it('closes past a quarter of the height', () => {
    expect(shouldClose({ dy: 130, height: 500, velocity: 0 })).toBe(true);
    expect(shouldClose({ dy: 100, height: 500, velocity: 0 })).toBe(false);
  });
  it('closes on a fast flick, but not a twitch', () => {
    expect(shouldClose({ dy: 40, height: 500, velocity: 1.2 })).toBe(true);
    expect(shouldClose({ dy: 8, height: 500, velocity: 2 })).toBe(false);
  });
  it('never closes on an upward drag', () => {
    expect(shouldClose({ dy: -50, height: 500, velocity: 3 })).toBe(false);
  });
});

describe('followY and dimAmount', () => {
  it('clamps upward movement', () => {
    expect(followY(-30)).toBe(0);
    expect(followY(42)).toBe(42);
  });
  it('fades the backdrop with the drag', () => {
    expect(dimAmount(0, 400)).toBe(1);
    expect(dimAmount(200, 400)).toBe(0.5);
    expect(dimAmount(900, 400)).toBe(0);
  });
});

describe('nextVelocity', () => {
  it('blends in the latest move and ignores zero time steps', () => {
    expect(nextVelocity(0, 10, 10)).toBeCloseTo(0.6);
    expect(nextVelocity(1, 10, 0)).toBe(1);
  });
});
