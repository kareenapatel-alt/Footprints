/**
 * Footprints – shared utilities, configuration, and helpers.
 * Loaded before content.js; exposes a single global `FootprintsUtils`.
 */
(function initFootprintsUtils(global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configurable thresholds (tweak here or via FootprintsUtils.CONFIG)
  // ---------------------------------------------------------------------------
  const CLICK_CLUSTER_RADIUS_PX = 80;
  const CLICK_CLUSTER_TIME_MS = 2000;
  const LONG_PAUSE_MS = 5000;
  const MIN_SCROLL_IGNORE_PX = 100;
  /** Default cap for stored / replay steps; runtime value lives on CONFIG (see applyMaxReplayActionsFromUserSetting). */
  const DEFAULT_MAX_REPLAY_ACTIONS = 4;

  /** Wall-clock duration of the replay overlay (ring + auto-dismiss); hop timing is derived from this. */
  const REPLAY_TOTAL_MS = 7000;

  const CONFIG = {
    CLICK_CLUSTER_RADIUS_PX,
    CLICK_CLUSTER_TIME_MS,
    LONG_PAUSE_MS,
    MIN_SCROLL_IGNORE_PX,
    MAX_REPLAY_ACTIONS: DEFAULT_MAX_REPLAY_ACTIONS,
    REPLAY_TOTAL_MS,
  };

  /** Clamp user-chosen history length (extension settings). */
  function applyMaxReplayActionsFromUserSetting(n) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) {
      CONFIG.MAX_REPLAY_ACTIONS = DEFAULT_MAX_REPLAY_ACTIONS;
      return;
    }
    CONFIG.MAX_REPLAY_ACTIONS = Math.max(3, Math.min(10, x));
  }

  // ---------------------------------------------------------------------------
  // Dev logging — prefix with [Footprints] for easy removal/filtering
  // ---------------------------------------------------------------------------
  const LOG_PREFIX = '[Footprints]';

  function log(section, ...args) {
    // eslint-disable-next-line no-console
    console.log(LOG_PREFIX, section, ...args);
  }

  function warn(section, ...args) {
    // eslint-disable-next-line no-console
    console.warn(LOG_PREFIX, section, ...args);
  }

  function distance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * True if a new click at (x,y,time) belongs to the current cluster.
   * Radius is measured from the first click in the burst (anchor), not the centroid,
   * so later clicks are not incorrectly rejected after the centroid moves.
   */
  function isInCluster(cluster, x, y, time) {
    if (!cluster) return false;
    if (time - cluster.startTime > CLICK_CLUSTER_TIME_MS) return false;
    return distance(cluster.anchorX, cluster.anchorY, x, y) <= CLICK_CLUSTER_RADIUS_PX;
  }

  /**
   * Merge a click into the cluster (centroid of points).
   */
  function mergeIntoCluster(cluster, x, y) {
    const n = cluster.count + 1;
    const nx = (cluster.x * cluster.count + x) / n;
    const ny = (cluster.y * cluster.count + y) / n;
    cluster.x = nx;
    cluster.y = ny;
    cluster.count = n;
    cluster.lastTime = Date.now();
    return cluster;
  }

  function startCluster(x, y) {
    const t = Date.now();
    return {
      anchorX: x,
      anchorY: y,
      x,
      y,
      startTime: t,
      lastTime: t,
      count: 1,
    };
  }

  /**
   * Lightweight, privacy-safe element descriptor. Returns null to skip recording.
   */
  function buildElementDescriptor(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') return null; // never record password fields
    }
    const id = el.id || '';
    const classes = el.className && typeof el.className === 'string'
      ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
      : '';
    let textSnippet = '';
    if (el.innerText) {
      const t = el.innerText.trim().replace(/\s+/g, ' ');
      if (t.length <= 40) textSnippet = t;
      else textSnippet = t.slice(0, 37) + '…';
    }
    return { tag, id, classes, textSnippet };
  }

  /**
   * Try to find an element for replay anchoring (best-effort).
   */
  function resolveElement(descriptor) {
    if (!descriptor) return null;
    try {
      if (descriptor.id) {
        const byId = document.getElementById(descriptor.id);
        if (byId && document.contains(byId)) return byId;
      }
      if (descriptor.tag && descriptor.classes) {
        const firstClass = descriptor.classes.split(/\s+/)[0];
        if (firstClass && typeof CSS !== 'undefined' && CSS.escape) {
          const sel = `${descriptor.tag}.${CSS.escape(firstClass)}`;
          const found = document.querySelector(sel);
          if (found && document.contains(found)) return found;
        } else if (firstClass) {
          const safe = firstClass.replace(/[^a-zA-Z0-9_-]/g, '');
          if (safe) {
            const found = document.querySelector(`${descriptor.tag}.${safe}`);
            if (found && document.contains(found)) return found;
          }
        }
      }
      if (descriptor.tag) {
        const list = document.getElementsByTagName(descriptor.tag);
        if (list.length === 1) return list[0];
      }
    } catch (e) {
      warn('resolveElement', e);
    }
    return null;
  }

  /**
   * Viewport position for replay: prefer live element rect; else saved coords + scroll delta.
   */
  function resolveReplayPoint(action) {
    const el = action.descriptor ? resolveElement(action.descriptor) : null;
    if (el) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return { x, y, usedElement: true };
    }
    const dsx = (action.scrollX || 0) - window.scrollX;
    const dsy = (action.scrollY || 0) - window.scrollY;
    return {
      x: (action.x || 0) + dsx,
      y: (action.y || 0) + dsy,
      usedElement: false,
    };
  }

  /**
   * Stable page key for matching stored steps to a document (hash stripped).
   */
  function normalizePageUrl(href) {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://invalid.invalid');
      return u.origin + u.pathname + u.search;
    } catch (e) {
      return href;
    }
  }

  /**
   * Host + path + query for “same document” checks. Ignores scheme (http/https),
   * trims trailing slashes on the path, lowercases host — avoids false “other page” gates.
   */
  function canonicalPageKey(href) {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://invalid.invalid');
      let path = u.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }
      return `${u.hostname.toLowerCase()}|${path}|${u.search}`;
    } catch (e) {
      return String(href);
    }
  }

  function normKeyForAction(action) {
    if (action.pageUrl) return canonicalPageKey(action.pageUrl);
    return '__legacy__';
  }

  /**
   * Contiguous block of actions backward from endIdx with the same page key.
   */
  function takeTrailingBlock(actions, endIdx) {
    if (endIdx < 0 || endIdx >= actions.length) {
      return { slice: [], navigateUrl: '', norm: '' };
    }
    const kn = normKeyForAction(actions[endIdx]);
    let k = endIdx;
    while (k > 0 && normKeyForAction(actions[k - 1]) === kn) k--;
    const slice = actions.slice(k, endIdx + 1);
    const raw = slice[0] && slice[0].pageUrl;
    return {
      slice,
      navigateUrl: raw || '',
      norm: raw ? canonicalPageKey(raw) : kn,
    };
  }

  /**
   * Pick steps to replay when the user may have navigated away from where clicks were recorded.
   * Prefers the latest contiguous block from a *different* page (previous page) when present.
   * @returns {{ slice: object[], needNav: boolean, navigateUrl: string, pageNorm: string }}
   */
  function pickReplaySegment(actions, currentHref) {
    const empty = { slice: [], needNav: false, navigateUrl: '', pageNorm: '' };
    if (!Array.isArray(actions) || !actions.length) return empty;
    const hereKey = canonicalPageKey(currentHref);

    function onCurrentPage(a) {
      if (!a.pageUrl) return true;
      return canonicalPageKey(a.pageUrl) === hereKey;
    }

    let j = actions.length - 1;
    while (j >= 0 && onCurrentPage(actions[j])) j--;

    if (j < 0) {
      const { slice, navigateUrl, norm } = takeTrailingBlock(actions, actions.length - 1);
      return {
        slice: slice.slice(-CONFIG.MAX_REPLAY_ACTIONS),
        needNav: false,
        navigateUrl,
        pageNorm: norm,
      };
    }

    const prev = takeTrailingBlock(actions, j);
    if (!prev.slice.length) return empty;

    if (prev.navigateUrl && prev.norm !== '__legacy__' && prev.norm !== hereKey) {
      return {
        /* Full contiguous block on the other page; “Go there” merges with all same-URL steps from the tab bucket. */
        slice: prev.slice,
        needNav: true,
        navigateUrl: prev.navigateUrl,
        pageNorm: prev.norm,
      };
    }

    const cur = takeTrailingBlock(actions, actions.length - 1);
    return {
      slice: cur.slice.slice(-CONFIG.MAX_REPLAY_ACTIONS),
      needNav: false,
      navigateUrl: cur.navigateUrl,
      pageNorm: cur.norm,
    };
  }

  /**
   * Document-space center for replay path (stable when the window scrolls).
   */
  function resolveReplayDocPoint(action) {
    const el = action.descriptor ? resolveElement(action.descriptor) : null;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) {
        return {
          x: r.left + r.width / 2 + window.scrollX,
          y: r.top + r.height / 2 + window.scrollY,
        };
      }
      /* Ambiguous resolve or collapsed layout — use stored click coordinates (document space). */
    }
    return {
      x: (action.x || 0) + (action.scrollX || 0),
      y: (action.y || 0) + (action.scrollY || 0),
    };
  }

  /**
   * All stored actions on a given normalized URL, in chronological order (tab bucket order).
   * Used when navigating back so replay can include every step on that page, not only one contiguous tail.
   */
  function filterActionsByPageNorm(actions, pageNorm) {
    if (!pageNorm || pageNorm === '__legacy__' || !Array.isArray(actions)) return [];
    return actions.filter(
      (a) => a && a.pageUrl && canonicalPageKey(a.pageUrl) === pageNorm
    );
  }

  /**
   * After “Go there” to another URL in the same tab: every stored step on that target page,
   * in chronological order, capped at MAX — e.g. 2 on page B then 2 on page A ⇒ 4 total across both replays.
   */
  function actionsToReplayAfterNavigate(allTabActions, pageNorm) {
    return filterActionsByPageNorm(allTabActions, pageNorm).slice(-CONFIG.MAX_REPLAY_ACTIONS);
  }

  function descriptorsEqual(d1, d2) {
    if (d1 == null && d2 == null) return true;
    if (d1 == null || d2 == null) return false;
    return (
      d1.tag === d2.tag &&
      d1.id === d2.id &&
      d1.classes === d2.classes &&
      d1.textSnippet === d2.textSnippet
    );
  }

  /**
   * True if `next` matches the last stored step (same type & page & target), e.g. double fire.
   */
  function isDuplicateConsecutiveAction(prev, next) {
    if (!prev || !next || prev.type !== next.type) return false;
    if (canonicalPageKey(prev.pageUrl || '') !== canonicalPageKey(next.pageUrl || '')) {
      return false;
    }
    if (prev.type === 'pause') return true;
    if (prev.type === 'click') {
      if ((prev.linkHref || '') !== (next.linkHref || '')) return false;
      if (prev.descriptor || next.descriptor) {
        return descriptorsEqual(prev.descriptor, next.descriptor);
      }
      return (
        Math.round(prev.x || 0) === Math.round(next.x || 0) &&
        Math.round(prev.y || 0) === Math.round(next.y || 0) &&
        (prev.scrollX | 0) === (next.scrollX | 0) &&
        (prev.scrollY | 0) === (next.scrollY | 0)
      );
    }
    return false;
  }

  global.FootprintsUtils = {
    CONFIG,
    applyMaxReplayActionsFromUserSetting,
    log,
    warn,
    distance,
    isInCluster,
    mergeIntoCluster,
    startCluster,
    buildElementDescriptor,
    resolveElement,
    resolveReplayPoint,
    resolveReplayDocPoint,
    normalizePageUrl,
    canonicalPageKey,
    pickReplaySegment,
    filterActionsByPageNorm,
    actionsToReplayAfterNavigate,
    isDuplicateConsecutiveAction,
  };
})(typeof self !== 'undefined' ? self : this);
