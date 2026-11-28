/**
 * Moves things during a back gesture (the maths is in predictiveBack.ts). One gesture at a time:
 * started() picks what is being left (the top sheet or dialog, else the page), progress() follows the
 * finger with a requestAnimationFrame, cancelled() springs back, invoked() finishes the animation and
 * does the back. Only transforms, opacity and a one-off clip are touched, set straight on the
 * elements so a gesture costs no React renders. With "reduce motion" nothing moves: back just acts.
 */
import { prefersReducedMotion } from './motion';
import {
  backTarget,
  canGoBackInApp,
  clamp01,
  dialogFrame,
  pageFrame,
  sheetFrame,
  topBackHandler,
  type BackHandler,
  type BackTarget,
  type SwipeEdge,
} from './predictiveBack';

const SPRING_MS = 240;
const FINISH_MS = 170;
const SPRING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

interface PageEl {
  el: HTMLElement;
  /** Prefix for elements that already centre themselves with a transform (the tab bar). */
  base: string;
  clip: boolean;
}

interface Active {
  target: BackTarget;
  handler?: BackHandler;
  edge: SwipeEdge;
  progress: number;
  still: boolean;
  panel?: HTMLElement;
  overlay?: HTMLElement;
  height: number;
  pages: PageEl[];
  lastRadius: number;
}

export interface Gesture {
  started(edge: SwipeEdge): void;
  progress(p: number, edge: SwipeEdge): void;
  cancelled(): void;
  invoked(): void;
  /** The route changed: fade the new page in if a gesture just finished, and tidy up. */
  routeCommitted(): void;
  dispose(): void;
}

/** What `goBack` does for a page (navigate(-1) in the app). */
export function createGesture(goBack: () => void): Gesture {
  let a: Active | null = null;
  let raf = 0;
  let timer = 0;
  let enterPending = false;
  const root = () => document.documentElement;

  const pageEls = (): PageEl[] =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.app > main, .app > .tabbar, .app > .story, .app > .app-banner',
      ),
    ).map((el) => ({
      el,
      base: el.classList.contains('tabbar') ? 'translateX(-50%) ' : '',
      clip: el.matches('main, .story'),
    }));

  const clearTimers = () => {
    window.cancelAnimationFrame(raf);
    raf = 0;
    window.clearTimeout(timer);
    timer = 0;
  };

  const reset = (el: HTMLElement) => {
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.transition = '';
    el.style.opacity = '';
    el.style.clipPath = '';
    el.style.willChange = '';
  };

  /** Take every inline style we set off again. */
  function cleanup() {
    clearTimers();
    if (a) {
      a.pages.forEach((p) => reset(p.el));
      if (a.panel) reset(a.panel);
      if (a.overlay) {
        a.overlay.style.removeProperty('--sheet-dim');
      }
    }
    root().classList.remove('pb-active');
    root().style.removeProperty('--pb-dim');
    a = null;
  }

  function paint(g: Active, p: number) {
    if (g.target === 'page') {
      // The screen swapped its elements mid-gesture (e.g. it finished loading): pick them up again.
      if (g.pages.length === 0 || g.pages.some((pe) => !pe.el.isConnected)) {
        g.lastRadius = -1;
        prepare(g);
      }
      const f = pageFrame(p, g.edge);
      root().style.setProperty('--pb-dim', f.dim.toFixed(3));
      const r = Math.round(f.radius);
      for (const pe of g.pages) {
        pe.el.style.transform = `translateX(${f.shiftX.toFixed(2)}px) scale(${f.scale.toFixed(4)}) ${pe.base}`;
        if (pe.clip && r !== g.lastRadius) pe.el.style.clipPath = clipFor(pe.el, r);
      }
      g.lastRadius = r;
    } else if (g.target === 'sheet' && g.panel) {
      const f = sheetFrame(p, g.height);
      g.panel.style.transform = `translateY(${f.translateY.toFixed(2)}px) scale(${f.scale.toFixed(4)})`;
      g.overlay?.style.setProperty('--sheet-dim', f.dim.toFixed(3));
    } else if (g.target === 'dialog' && g.panel) {
      const f = dialogFrame(p);
      g.panel.style.transform = `scale(${f.scale.toFixed(4)})`;
      g.panel.style.opacity = f.opacity.toFixed(3);
    }
  }

  /** The visible window of a page element, in its own coordinates, with rounded corners. */
  const clips = new WeakMap<HTMLElement, DOMRect>();
  function clipFor(el: HTMLElement, radius: number): string {
    const r = clips.get(el);
    if (!r) return '';
    return `inset(${-r.top}px ${r.right - window.innerWidth}px ${r.bottom - window.innerHeight}px ${-r.left}px round ${radius}px)`;
  }

  function prepare(g: Active) {
    if (g.target === 'page') {
      g.pages = pageEls();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const pe of g.pages) {
        const r = pe.el.getBoundingClientRect();
        clips.set(pe.el, r);
        // Scale about the middle of the screen, not the middle of a tall page.
        const left = r.left + (pe.base ? r.width / 2 : 0);
        pe.el.style.transformOrigin = `${vw / 2 - left}px ${vh / 2 - r.top}px`;
        pe.el.style.willChange = 'transform';
      }
      root().classList.add('pb-active');
    } else if (g.panel) {
      g.height = g.panel.getBoundingClientRect().height;
      g.panel.style.transition = 'none';
      g.panel.style.animation = 'none';
      g.panel.style.willChange = 'transform, opacity';
      g.panel.style.transformOrigin = g.target === 'sheet' ? '50% 100%' : '50% 50%';
    }
  }

  const act = (g: Pick<Active, 'target' | 'handler'>) => {
    if (g.target === 'page') {
      enterPending = true;
      goBack();
      // If the route doesn't change after all, don't leave things dimmed.
      timer = window.setTimeout(() => {
        enterPending = false;
        cleanup();
      }, 600);
    } else g.handler?.close();
  };

  return {
    started(edge) {
      cleanup();
      const handler = topBackHandler();
      const target = backTarget(handler, canGoBackInApp());
      if (target === 'none') return;
      const panel = handler?.target?.current ?? undefined;
      a = {
        target,
        handler,
        edge,
        progress: 0,
        still: prefersReducedMotion(),
        panel,
        overlay: handler?.overlay?.current ?? undefined,
        height: 0,
        pages: [],
        lastRadius: -1,
      };
      if (!a.still) prepare(a);
    },
    progress(p, edge) {
      const g = a;
      if (!g || g.still) return;
      g.progress = clamp01(p);
      g.edge = edge;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (a === g) paint(g, g.progress);
      });
    },
    cancelled() {
      const g = a;
      if (!g) return;
      window.cancelAnimationFrame(raf);
      raf = 0;
      if (g.still) return cleanup();
      const els = g.target === 'page' ? g.pages.map((p) => p.el) : g.panel ? [g.panel] : [];
      els.forEach(
        (el) =>
          (el.style.transition = `transform ${SPRING_MS}ms ${SPRING}, opacity ${SPRING_MS}ms ${SPRING}, clip-path ${SPRING_MS}ms ${SPRING}`),
      );
      paint(g, 0);
      g.pages.forEach((pe) => pe.clip && (pe.el.style.clipPath = clipFor(pe.el, 0)));
      timer = window.setTimeout(cleanup, SPRING_MS + 30);
    },
    invoked() {
      const g = a;
      // No gesture was shown (older Android sends only the press): just do it.
      if (!g || g.still) {
        const handler = g?.handler ?? topBackHandler();
        const target = g?.target ?? backTarget(handler, canGoBackInApp());
        cleanup();
        if (target !== 'none') act({ target, handler });
        return;
      }
      window.cancelAnimationFrame(raf);
      raf = 0;
      const done = () => {
        act(g);
        // A sheet that stayed (the close was refused) comes back; a closed one is already gone.
        if (g.target !== 'page') timer = window.setTimeout(cleanup, 150);
      };
      if (g.target === 'page') {
        const ms = `${FINISH_MS}ms`;
        for (const pe of g.pages) {
          pe.el.style.transition = `transform ${ms} ease-in, opacity ${ms} ease-in`;
          pe.el.style.opacity = '0';
        }
        paint(g, 1);
        timer = window.setTimeout(done, FINISH_MS);
      } else if (g.panel) {
        g.panel.style.transition = `transform ${FINISH_MS}ms ease-in, opacity ${FINISH_MS}ms ease-in`;
        if (g.target === 'sheet') {
          g.panel.style.transform = `translateY(${g.height}px)`;
          g.overlay?.style.setProperty('--sheet-dim', '0');
        } else {
          paint(g, 1);
          g.panel.style.opacity = '0';
        }
        timer = window.setTimeout(done, FINISH_MS);
      } else done();
    },
    routeCommitted() {
      if (!enterPending) return;
      enterPending = false;
      window.clearTimeout(timer);
      // The new page's elements exist now; fade them in before they are first painted.
      a = null;
      root().classList.remove('pb-active');
      root().style.removeProperty('--pb-dim');
      root().classList.add('pb-enter');
      timer = window.setTimeout(() => root().classList.remove('pb-enter'), 260);
    },
    dispose() {
      cleanup();
      root().classList.remove('pb-enter');
    },
  };
}
