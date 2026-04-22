/**
 * Footprints – service worker (Manifest V3).
 * Persists recent actions per tab in chrome.storage.local so they survive page refresh.
 * Keys are removed when the tab closes (see tabs.onRemoved).
 */
importScripts('utils.js');

(function () {
  'use strict';

  const { canonicalPageKey } = FootprintsUtils;

  /** First-install defaults (must match popup/content fallbacks when keys are absent). */
  const DEFAULT_FP_SHOW_FLOATING_WIDGET = true;
  const DEFAULT_FP_MAX_STORED_ACTIONS = 4;

  /** `chrome.storage.session` (Chrome 102+); opener-tab pairing is skipped if missing. */
  const sess = chrome.storage && chrome.storage.session;

  /** @param {number} tabId */
  function storageKey(tabId) {
    return `footprints_tab_${tabId}`;
  }

  /** @param {number} tabId */
  function pendingReplayKey(tabId) {
    return `footprints_pendingReplay_${tabId}`;
  }

  /** @param {number} tabId */
  function replaySessionStorageKey(tabId) {
    return `footprints_replay_session_${tabId}`;
  }

  /** One-shot FAB position to apply after replay navigates back (per tab). */
  function fabPendingRestoreKey(tabId) {
    return `footprints_fab_restore_${tabId}`;
  }

  /** Session: last “open in new tab” click on an opener tab (paired in tabs.onCreated). */
  function pendingAnchorKey(openerTabId) {
    return `footprints_sess_pending_anchor_${openerTabId}`;
  }

  /** Session: child tab was opened from opener; used for “Take me to the tab” after short replay. */
  function childOpenKey(childTabId) {
    return `footprints_sess_child_open_${childTabId}`;
  }

  const PENDING_ANCHOR_MAX_AGE_MS = 8000;

  function synthesizeAnchorFromActions(actions) {
    if (!Array.isArray(actions)) return null;
    function pack(rec) {
      return {
        descriptor: rec.descriptor,
        linkHref: rec.linkHref,
        x: rec.x,
        y: rec.y,
        scrollX: rec.scrollX,
        scrollY: rec.scrollY,
        pageUrl: rec.pageUrl,
      };
    }
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (a && a.type === 'click' && a.descriptor && a.descriptor.tag === 'a') {
        return pack(a);
      }
    }
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (
        a &&
        a.type === 'click' &&
        (a.descriptor != null || (a.x != null && a.scrollX != null))
      ) {
        return pack(a);
      }
    }
    return null;
  }

  function tabOrigin(href) {
    try {
      return new URL(href).origin;
    } catch (e) {
      return '';
    }
  }

  /**
   * When the browser does not report openerTabId (e.g. context-menu “open in new tab”) or pairing
   * missed the link click, use document.referrer + tabs in the same window to find the source tab.
   */
  async function tryPairChildByReferrer(childTabId, pageUrl, referrer) {
    if (!sess || !referrer || !/^https?:\/\//i.test(referrer)) return;
    const refNorm = canonicalPageKey(referrer);
    const hereNorm = canonicalPageKey(pageUrl || '');
    if (!refNorm) return;
    if (hereNorm && refNorm === hereNorm) return;

    const ck = childOpenKey(childTabId);
    const existing = await sess.get(ck);
    if (existing[ck]) return;

    let childTab;
    try {
      childTab = await chrome.tabs.get(childTabId);
    } catch (e) {
      return;
    }

    const winTabs = await chrome.tabs.query({ windowId: childTab.windowId });
    const others = winTabs.filter(
      (t) => t.id !== childTabId && t.url && /^https?:\/\//i.test(t.url)
    );

    let matches = others.filter((t) => canonicalPageKey(t.url) === refNorm);
    if (matches.length === 0) {
      const ro = tabOrigin(referrer);
      if (!ro) return;
      matches = others.filter((t) => tabOrigin(t.url) === ro);
    }
    if (matches.length === 0) return;

    const openerTab = matches.find((t) => t.active) || matches[matches.length - 1];
    const actions = await getActions(openerTab.id);
    const anchor = synthesizeAnchorFromActions(actions);
    const again = await sess.get(ck);
    if (again[ck]) return;
    await sess.set({
      [ck]: { openerTabId: openerTab.id, anchor },
    });
  }

  /**
   * After navigation, content script consumes this and runs replay when URL matches replayNorm.
   * @param {number} tabId
   * @param {object[]} actions
   * @param {string} replayNorm canonical page key (FootprintsUtils.canonicalPageKey)
   */
  async function setPendingReplay(tabId, actions, replayNorm) {
    const key = pendingReplayKey(tabId);
    await chrome.storage.local.set({
      [key]: { actions, pageNorm: replayNorm },
    });
  }

  /**
   * @param {number} tabId
   * @param {string} pageUrl current location.href from content
   */
  /** Pending replay may store pageNorm as a canonical key or (legacy) as a full URL string. */
  function pendingReplayNormKey(s) {
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return canonicalPageKey(s);
    return s;
  }

  async function consumePendingReplay(tabId, pageUrl) {
    const key = pendingReplayKey(tabId);
    const data = await chrome.storage.local.get(key);
    const pack = data[key];
    if (!pack || !Array.isArray(pack.actions) || !pack.actions.length) {
      return { ok: false };
    }
    const here = canonicalPageKey(pageUrl || '');
    const stored = pendingReplayNormKey(pack.pageNorm || '');
    if (!here || !stored || here !== stored) {
      return { ok: false };
    }
    await chrome.storage.local.remove(key);
    return { ok: true, actions: pack.actions };
  }

  async function getUserMaxReplayActions() {
    const r = await chrome.storage.local.get({
      fpMaxStoredActions: DEFAULT_FP_MAX_STORED_ACTIONS,
    });
    let n = Math.round(Number(r.fpMaxStoredActions));
    if (!Number.isFinite(n)) n = DEFAULT_FP_MAX_STORED_ACTIONS;
    return Math.max(3, Math.min(10, n));
  }

  /**
   * Trim to the last N entries (N from extension settings).
   * @param {object[]} actions
   */
  async function trimActions(actions) {
    const max = await getUserMaxReplayActions();
    if (!Array.isArray(actions) || actions.length <= max) return actions || [];
    return actions.slice(-max);
  }

  /**
   * @param {number} tabId
   * @returns {Promise<object[]>}
   */
  async function getActions(tabId) {
    const key = storageKey(tabId);
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    return entry && Array.isArray(entry.actions) ? entry.actions : [];
  }

  /**
   * Same browser window as `excludeTabId`: pick the http(s) tab (other than exclude) with the most
   * stored actions, so the popup can direct users when footsteps live on another tab.
   * @param {number} excludeTabId
   * @returns {Promise<{ tabId: number, windowId: number, title: string, count: number } | null>}
   */
  async function findBestPeerTabWithStoredSteps(excludeTabId) {
    let base;
    try {
      base = await chrome.tabs.get(excludeTabId);
    } catch (e) {
      return null;
    }
    if (!base || base.windowId == null) return null;
    const winTabs = await chrome.tabs.query({ windowId: base.windowId });
    let best = null;
    for (const t of winTabs) {
      if (t.id == null || t.id === excludeTabId) continue;
      const u = t.url || '';
      if (!/^https?:\/\//i.test(u)) continue;
      const actions = await getActions(t.id);
      const n = actions.length;
      if (n === 0) continue;
      if (!best || n > best.count) {
        const rawTitle = (t.title && String(t.title).trim()) || u || 'Tab';
        const title = rawTitle.length > 52 ? rawTitle.slice(0, 50) + '…' : rawTitle;
        best = { tabId: t.id, windowId: base.windowId, count: n, title };
      }
    }
    return best;
  }

  /**
   * @param {number} tabId
   * @param {object[]} actions
   */
  async function setActions(tabId, actions) {
    const key = storageKey(tabId);
    const trimmed = await trimActions(actions);
    await chrome.storage.local.set({
      [key]: { actions: trimmed },
    });
  }

  chrome.storage.local.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.fpMaxStoredActions) return;
    (async () => {
      const max = await getUserMaxReplayActions();
      let all;
      try {
        all = await chrome.storage.local.get(null);
      } catch (e) {
        return;
      }
      const updates = {};
      for (const k of Object.keys(all || {})) {
        if (!k.startsWith('footprints_tab_')) continue;
        const entry = all[k];
        if (!entry || !Array.isArray(entry.actions) || entry.actions.length <= max) continue;
        updates[k] = { actions: entry.actions.slice(-max) };
      }
      if (Object.keys(updates).length) {
        await chrome.storage.local.set(updates);
      }
    })();
  });

  /**
   * Append one meaningful action; drop oldest beyond cap.
   * @param {number} tabId
   * @param {object} action
   */
  async function appendAction(tabId, action) {
    const current = await getActions(tabId);
    const last = current.length ? current[current.length - 1] : null;
    if (FootprintsUtils.isDuplicateConsecutiveAction(last, action)) {
      FootprintsUtils.log('storage', 'skip duplicate', action.type);
      return;
    }
    current.push(action);
    await setActions(tabId, current);
    FootprintsUtils.log('storage', 'append', action.type, 'count=', current.length);
  }

  /**
   * Popup must pass tabId (sender.tab is missing there). Coerce in case of JSON quirks.
   * @returns {number | null}
   */
  function resolveTabId(message, sender) {
    if (message.tabId != null && message.tabId !== '') {
      const n = Number(message.tabId);
      if (Number.isFinite(n)) return n;
    }
    const sid = sender && sender.tab && sender.tab.id;
    if (sid != null && sid !== '') {
      const n = Number(sid);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = resolveTabId(message, sender);
    if (tabId == null) {
      sendResponse({ ok: false, error: 'no_tab' });
      return false;
    }

    if (message.type === 'FOOTPRINTS_APPEND_ACTION') {
      appendAction(tabId, message.action)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          FootprintsUtils.warn('background', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_GET_ACTIONS') {
      getActions(tabId)
        .then((actions) => sendResponse({ ok: true, actions }))
        .catch((e) => {
          FootprintsUtils.warn('background', e);
          sendResponse({ ok: false, actions: [], error: String(e) });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_GET_COUNT') {
      getActions(tabId)
        .then(async (actions) => {
          let hasChildOpenContext = false;
          if (sess) {
            const k = childOpenKey(tabId);
            try {
              const data = await sess.get(k);
              const pack = data[k];
              hasChildOpenContext = !!(pack && pack.openerTabId != null);
            } catch (e) {
              FootprintsUtils.warn('background', e);
            }
          }
          sendResponse({ ok: true, count: actions.length, hasChildOpenContext });
        })
        .catch(() => sendResponse({ ok: true, count: 0, hasChildOpenContext: false }));
      return true;
    }

    if (message.type === 'FOOTPRINTS_GET_OTHER_TAB_WITH_STEPS') {
      findBestPeerTabWithStoredSteps(tabId)
        .then((peer) => sendResponse({ ok: true, peer }))
        .catch((e) => {
          FootprintsUtils.warn('background', 'peer tab steps', e);
          sendResponse({ ok: true, peer: null });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_STORE_PENDING_REPLAY') {
      const replayNorm = message.pageNorm || '';
      const acts = Array.isArray(message.actions) ? message.actions : [];
      setPendingReplay(tabId, acts, replayNorm)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          FootprintsUtils.warn('background', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_CONSUME_PENDING_REPLAY') {
      consumePendingReplay(tabId, message.pageUrl)
        .then((r) => sendResponse(r))
        .catch((e) => {
          FootprintsUtils.warn('background', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_GET_REPLAY_SESSION') {
      const k = replaySessionStorageKey(tabId);
      chrome.storage.local.get(k, (data) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, session: null });
          return;
        }
        sendResponse({ ok: true, session: data[k] || null });
      });
      return true;
    }

    if (message.type === 'FOOTPRINTS_SET_REPLAY_SESSION') {
      const k = replaySessionStorageKey(tabId);
      const session = message.session;
      if (!session || typeof session !== 'object') {
        sendResponse({ ok: false });
        return false;
      }
      chrome.storage.local.set({ [k]: session }, () => {
        if (chrome.runtime.lastError) sendResponse({ ok: false });
        else sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === 'FOOTPRINTS_CLEAR_REPLAY_SESSION') {
      const k = replaySessionStorageKey(tabId);
      chrome.storage.local.remove(k, () => sendResponse({ ok: true }));
      return true;
    }

    if (message.type === 'FOOTPRINTS_SET_PENDING_FAB_RESTORE') {
      const pos = message.pos;
      if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') {
        sendResponse({ ok: false });
        return false;
      }
      const fk = fabPendingRestoreKey(tabId);
      chrome.storage.local.set({ [fk]: { left: pos.left, top: pos.top } }, () => {
        if (chrome.runtime.lastError) sendResponse({ ok: false });
        else sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === 'FOOTPRINTS_POP_PENDING_FAB_RESTORE') {
      const fk = fabPendingRestoreKey(tabId);
      chrome.storage.local.get(fk, (data) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: true, pos: null });
          return;
        }
        const pos = data[fk];
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') {
          sendResponse({ ok: true, pos: null });
          return;
        }
        chrome.storage.local.remove(fk, () => {
          sendResponse({ ok: true, pos: { left: pos.left, top: pos.top } });
        });
      });
      return true;
    }

    if (message.type === 'FOOTPRINTS_REGISTER_NEW_TAB_ANCHOR') {
      const anchor = message.anchor;
      if (!anchor || typeof anchor !== 'object') {
        sendResponse({ ok: false });
        return false;
      }
      if (!sess) {
        sendResponse({ ok: true });
        return false;
      }
      sess
        .set({
          [pendingAnchorKey(tabId)]: { anchor, ts: Date.now() },
        })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          FootprintsUtils.warn('background', e);
          sendResponse({ ok: false });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_GET_CHILD_OPEN_CONTEXT') {
      if (!sess) {
        sendResponse({ ok: true, hasContext: false });
        return false;
      }
      const k = childOpenKey(tabId);
      sess
        .get(k)
        .then((data) => {
          const pack = data[k];
          if (!pack || pack.openerTabId == null) {
            sendResponse({ ok: true, hasContext: false });
            return;
          }
          sendResponse({
            ok: true,
            hasContext: true,
            openerTabId: pack.openerTabId,
            anchor: pack.anchor || null,
          });
        })
        .catch(() => sendResponse({ ok: true, hasContext: false }));
      return true;
    }

    if (message.type === 'FOOTPRINTS_CHILD_TAB_READY') {
      if (!sess) {
        sendResponse({ ok: true });
        return false;
      }
      tryPairChildByReferrer(tabId, message.pageUrl || '', message.referrer || '')
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: true }));
      return true;
    }

    if (message.type === 'FOOTPRINTS_ACTIVATE_PEER_TAB_FOR_REPLAY') {
      const targetId = Number(message.peerTabId);
      if (!Number.isFinite(targetId)) {
        sendResponse({ ok: false, error: 'bad_tab' });
        return false;
      }
      Promise.all([chrome.tabs.get(tabId).catch(() => null), chrome.tabs.get(targetId).catch(() => null)])
        .then(([senderTab, peerTab]) => {
          if (!senderTab || !peerTab || peerTab.id == null) {
            sendResponse({ ok: false, error: 'no_tab' });
            return;
          }
          if (peerTab.windowId !== senderTab.windowId) {
            sendResponse({ ok: false, error: 'wrong_window' });
            return;
          }
          return chrome.windows.update(peerTab.windowId, { focused: true }).then(() =>
            chrome.tabs.update(targetId, { active: true }),
          ).then(() => sendResponse({ ok: true }));
        })
        .catch((e) => {
          FootprintsUtils.warn('background', 'activate peer tab', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true;
    }

    if (message.type === 'FOOTPRINTS_ACTIVATE_OPENER_FOR_CHILD') {
      if (!sess) {
        sendResponse({ ok: false, error: 'no_session' });
        return false;
      }
      const k = childOpenKey(tabId);
      sess
        .get(k)
        .then(async (data) => {
          const pack = data[k];
          if (!pack || pack.openerTabId == null) {
            sendResponse({ ok: false, error: 'no_context' });
            return;
          }
          const openerId = pack.openerTabId;
          const anchor = pack.anchor;
          try {
            const openerTab = await chrome.tabs.get(openerId);
            await chrome.windows.update(openerTab.windowId, { focused: true });
            await chrome.tabs.update(openerId, { active: true });
            await sess.remove(k);
            const hintMsg = { type: 'FOOTPRINTS_SHOW_OPENED_LINK_HINT', anchor };
            for (let attempt = 0; attempt < 6; attempt++) {
              if (attempt > 0) {
                await new Promise((r) => setTimeout(r, 120 * attempt));
              }
              try {
                await chrome.tabs.sendMessage(openerId, hintMsg);
                break;
              } catch (e) {
                if (attempt === 5) FootprintsUtils.warn('background', 'opener hint', e);
              }
            }
            sendResponse({ ok: true });
          } catch (e) {
            FootprintsUtils.warn('background', e);
            sendResponse({ ok: false, error: String(e) });
          }
        })
        .catch((e) => {
          FootprintsUtils.warn('background', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true;
    }

    return false;
  });

  /**
   * Pair a child tab with the last “new tab” link click on the opener. Retries fix races where
   * onCreated runs before the REGISTER_NEW_TAB_ANCHOR message is written.
   */
  function tryPairChildFromOpener(tab) {
    if (!sess || tab.id == null || tab.openerTabId == null) return;
    const ck = childOpenKey(tab.id);
    const openerId = tab.openerTabId;
    sess.get(ck).then((existing) => {
      if (existing[ck]) return;
      const pendKey = pendingAnchorKey(openerId);
      sess.get(pendKey).then((data) => {
        const pending = data[pendKey];
        const pendingFresh =
          pending &&
          pending.anchor &&
          Date.now() - (pending.ts || 0) <= PENDING_ANCHOR_MAX_AGE_MS;
        if (pendingFresh) {
          sess
            .set({ [ck]: { openerTabId: openerId, anchor: pending.anchor } })
            .then(() => sess.remove(pendKey))
            .catch(() => {});
          return;
        }
        if (pending && !pendingFresh) {
          sess.remove(pendKey).catch(() => {});
        }
        getActions(openerId)
          .then((actions) =>
            sess.get(ck).then((again) => {
              if (again[ck]) return;
              const anchor = synthesizeAnchorFromActions(actions);
              return sess.set({ [ck]: { openerTabId: openerId, anchor } });
            })
          )
          .catch(() => {});
      });
    });
  }

  if (sess) {
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id == null || tab.openerTabId == null) return;
      tryPairChildFromOpener(tab);
      setTimeout(() => tryPairChildFromOpener(tab), 40);
      setTimeout(() => tryPairChildFromOpener(tab), 120);
      setTimeout(() => tryPairChildFromOpener(tab), 400);
    });
  }

  /** Drop this tab’s bucket when the tab closes (no unbounded growth). */
  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.remove([storageKey(tabId), pendingReplayKey(tabId)]).catch(() => {});
    if (sess) {
      sess.remove([pendingAnchorKey(tabId), childOpenKey(tabId)]).catch(() => {});
    }
  });

  function tabIsReplayable(t) {
    return !!(t && t.id != null && t.url && /^https?:\/\//i.test(t.url));
  }

  /**
   * Active tab in the user’s last-focused normal browser window (not the extension popup).
   * Extra fallbacks fix ⌘⇧E when `lastFocusedWindow` still points at the wrong window.
   */
  async function findReplayTargetTab() {
    async function fromQuery(q) {
      const tabs = await chrome.tabs.query(q);
      const t = tabs && tabs[0];
      return tabIsReplayable(t) ? t : null;
    }
    let t = await fromQuery({ active: true, lastFocusedWindow: true });
    if (t) return t;
    t = await fromQuery({ active: true, currentWindow: true });
    if (t) return t;
    try {
      const actives = await chrome.tabs.query({ active: true });
      for (const tab of actives || []) {
        if (tabIsReplayable(tab)) return tab;
      }
    } catch (e) {
      FootprintsUtils.warn('background', 'findReplayTargetTab scan', e);
    }
    return null;
  }

  /**
   * Same as clicking the floating bunny: run on-page replay overlay (compact) on the focused http(s) tab.
   */
  async function triggerReplayOnActiveTab() {
    const t = await findReplayTargetTab();
    if (!t || t.id == null) {
      FootprintsUtils.warn('background', 'triggerReplay: no http(s) tab');
      return;
    }
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'FOOTPRINTS_START_REPLAY', compact: true });
    } catch (e) {
      FootprintsUtils.warn('background', 'triggerReplay', e);
    }
  }

  chrome.commands.onCommand.addListener((command) => {
    /* Do not use _execute_action here: Chrome opens default_popup instead and usually skips this listener. */
    if (command === 'start_replay') {
      triggerReplayOnActiveTab().catch(() => {});
    }
  });

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    chrome.storage.local.get(['fpShowFloatingWidget', 'fpMaxStoredActions'], (r) => {
      if (chrome.runtime.lastError) return;
      const next = {};
      if (!Object.prototype.hasOwnProperty.call(r, 'fpShowFloatingWidget')) {
        next.fpShowFloatingWidget = DEFAULT_FP_SHOW_FLOATING_WIDGET;
      }
      if (!Object.prototype.hasOwnProperty.call(r, 'fpMaxStoredActions')) {
        next.fpMaxStoredActions = DEFAULT_FP_MAX_STORED_ACTIONS;
      }
      if (Object.keys(next).length) {
        chrome.storage.local.set(next, () => void chrome.runtime.lastError);
      }
    });
  });

  FootprintsUtils.log('background', 'service worker ready');
})();
