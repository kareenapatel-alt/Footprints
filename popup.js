/**
 * Footprints – popup: manual replay + tab action count (per-tab storage via background).
 */
(function () {
  'use strict';

  const FOOTPRINTS_ANIMALS = globalThis.FOOTPRINTS_ANIMALS;
  const FOOTPRINTS_MASCOT_STORAGE_KEY = globalThis.FOOTPRINTS_MASCOT_STORAGE_KEY;
  const FOOTPRINTS_DEFAULT_MASCOT_ID = globalThis.FOOTPRINTS_DEFAULT_MASCOT_ID;
  const getFootprintsAnimal = globalThis.getFootprintsAnimal;

  const replayBtn = document.getElementById('replay');
  const statsEl = document.getElementById('stats');
  const peerTabRow = document.getElementById('peer-tab-row');
  const peerTabJump = document.getElementById('peer-tab-jump');
  const errEl = document.getElementById('err');
  const settingsBtn = document.getElementById('settings');
  const mascotPickTrigger = document.getElementById('fp-mascot-pick');
  const mascotPickList = document.getElementById('fp-mascot-listbox');
  const mascotPickWrap = mascotPickTrigger ? mascotPickTrigger.closest('.mascot-picker-wrap') : null;
  const mascotPickTriggerImg = mascotPickTrigger
    ? mascotPickTrigger.querySelector('.mascot-picker-trigger-img')
    : null;
  const mascotPickTriggerLabel = mascotPickTrigger
    ? mascotPickTrigger.querySelector('.mascot-picker-trigger-label')
    : null;

  const FP_SHOW_FLOATING_WIDGET_KEY = 'fpShowFloatingWidget';
  const FP_MAX_STORED_ACTIONS_KEY = 'fpMaxStoredActions';

  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsBackdrop = document.getElementById('settings-backdrop');
  const settingsClose = document.getElementById('settings-close');
  const settingsDone = document.getElementById('settings-done');
  const showLauncherCb = document.getElementById('fp-setting-show-launcher');
  const maxActionsRange = document.getElementById('fp-setting-max-actions');
  const maxActionsValue = document.getElementById('fp-setting-max-value');

  function setMascotPickerUi(id) {
    const animal = getFootprintsAnimal(id);
    if (mascotPickTriggerImg) {
      mascotPickTriggerImg.src = chrome.runtime.getURL(animal.path);
      mascotPickTriggerImg.alt = '';
    }
    if (mascotPickTriggerLabel) {
      mascotPickTriggerLabel.textContent = animal.label;
    }
    if (mascotPickList) {
      mascotPickList.querySelectorAll('[role="option"]').forEach((opt) => {
        opt.setAttribute('aria-selected', opt.getAttribute('data-animal-id') === animal.id ? 'true' : 'false');
      });
    }
  }

  function closeMascotPickerList() {
    if (!mascotPickList || !mascotPickTrigger) return;
    mascotPickList.hidden = true;
    mascotPickTrigger.setAttribute('aria-expanded', 'false');
    if (mascotPickWrap) mascotPickWrap.classList.remove('fp-open');
  }

  function syncMascotPickerReserve() {
    if (!mascotPickList) return;
    const reservePx = mascotPickList.hidden ? 80 : Math.max(80, mascotPickList.scrollHeight + 10);
    document.documentElement.style.setProperty('--popup-dropdown-reserve', `${reservePx}px`);
  }

  function openMascotPickerList() {
    if (!mascotPickList || !mascotPickTrigger) return;
    mascotPickList.hidden = false;
    mascotPickTrigger.setAttribute('aria-expanded', 'true');
    if (mascotPickWrap) mascotPickWrap.classList.add('fp-open');
    syncMascotPickerReserve();
  }

  if (FOOTPRINTS_ANIMALS && mascotPickTrigger && mascotPickList) {
    syncMascotPickerReserve();
    FOOTPRINTS_ANIMALS.forEach((animal) => {
      const optBtn = document.createElement('button');
      optBtn.type = 'button';
      optBtn.setAttribute('role', 'option');
      optBtn.className = 'mascot-picker-option';
      optBtn.setAttribute('data-animal-id', animal.id);
      const img = document.createElement('img');
      img.className = 'mascot-picker-option-img';
      img.src = chrome.runtime.getURL(animal.path);
      img.alt = '';
      img.width = 28;
      img.height = 28;
      img.decoding = 'async';
      const nameEl = document.createElement('span');
      nameEl.textContent = animal.label;
      optBtn.appendChild(img);
      optBtn.appendChild(nameEl);
      optBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = animal.id;
        chrome.storage.local.set({ fpMascotAnimalId: id }, () => void chrome.runtime.lastError);
        setMascotPickerUi(id);
        closeMascotPickerList();
        mascotPickTrigger.focus();
      });
      mascotPickList.appendChild(optBtn);
    });
    syncMascotPickerReserve();

    chrome.storage.local.get({ fpMascotAnimalId: FOOTPRINTS_DEFAULT_MASCOT_ID }, (r) => {
      if (chrome.runtime.lastError) return;
      const id = getFootprintsAnimal(r.fpMascotAnimalId).id;
      setMascotPickerUi(id);
    });

    mascotPickTrigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (mascotPickList.hidden) openMascotPickerList();
      else closeMascotPickerList();
    });

    document.addEventListener('click', () => {
      closeMascotPickerList();
    });

    mascotPickTrigger.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        closeMascotPickerList();
      }
    });

    mascotPickList.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeMascotPickerList();
        mascotPickTrigger.focus();
      }
    });
    window.addEventListener('resize', syncMascotPickerReserve);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, FOOTPRINTS_MASCOT_STORAGE_KEY)) {
        return;
      }
      const id = getFootprintsAnimal(changes[FOOTPRINTS_MASCOT_STORAGE_KEY].newValue).id;
      setMascotPickerUi(id);
    });
  }

  function showErr(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  /**
   * Stats strip for counts & child-opener context. When n === 0 and there is no opener context, the
   * peer-tab probe in refreshCount fills the message (or “No actions taken.”).
   */
  function setStatsForCount(n, hasChildOpenContext) {
    if (n === 0 && hasChildOpenContext) {
      statsEl.textContent =
        'No actions yet. This tab was opened from another. Use Retrace to jump back to the link.';
      statsEl.hidden = false;
    } else if (n === 0) {
      statsEl.textContent = '';
      statsEl.hidden = true;
    } else {
      statsEl.textContent = '';
      statsEl.hidden = true;
    }
  }

  /**
   * From the extension popup, currentWindow can be wrong; lastFocusedWindow is the page the user was on.
   */
  function getActiveTab(callback) {
    const finish = (tabs, err) => {
      if (err) {
        callback(null, err);
        return;
      }
      const t = tabs && tabs[0];
      if (!t || t.id == null) {
        callback(null, 'No active tab.');
        return;
      }
      callback(t, null);
    };

    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        finish(null, chrome.runtime.lastError.message);
        return;
      }
      if (tabs && tabs[0] && tabs[0].id != null) {
        finish(tabs, null);
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs2) => {
        if (chrome.runtime.lastError) {
          finish(null, chrome.runtime.lastError.message);
          return;
        }
        finish(tabs2, null);
      });
    });
  }

  function hidePeerTabHint() {
    if (peerTabRow) peerTabRow.hidden = true;
    if (peerTabJump) {
      peerTabJump.removeAttribute('data-tab-id');
      peerTabJump.removeAttribute('data-window-id');
    }
  }

  function refreshCount() {
    showErr('');
    statsEl.hidden = true;
    statsEl.textContent = '';
    hidePeerTabHint();
    getActiveTab((tab, err) => {
      if (err) {
        showErr(err);
        replayBtn.disabled = true;
        return;
      }
      const url = tab.url || '';
      if (!/^https?:\/\//i.test(url)) {
        showErr('Footprints only runs on normal web pages (http/https), not system pages.');
        replayBtn.disabled = true;
        return;
      }

      const tabId = tab.id;
      // Flush pending click cluster and wait for storage before counting (avoids race with 2s debounce + async save).
      chrome.tabs.sendMessage(tabId, { type: 'FOOTPRINTS_FLUSH_PENDING' }, () => {
        if (chrome.runtime.lastError) {
          /* No content script on this tab — still query count */
        }
        chrome.runtime.sendMessage(
          { type: 'FOOTPRINTS_GET_COUNT', tabId: Number(tabId) },
          (res) => {
            if (chrome.runtime.lastError) {
              showErr(chrome.runtime.lastError.message);
              replayBtn.disabled = true;
              return;
            }
            if (!res || res.ok === false) {
              showErr(
                (res && res.error) ||
                  'Could not load stored steps. Reload the extension or this page and try again.'
              );
              replayBtn.disabled = true;
              return;
            }
            const n = typeof res.count === 'number' ? res.count : 0;
            const hasChildOpenContext = !!res.hasChildOpenContext;
            setStatsForCount(n, hasChildOpenContext);
            replayBtn.disabled = n < 1 && !hasChildOpenContext;
            if (n === 0 && !hasChildOpenContext) {
              if (peerTabRow && peerTabJump) {
                chrome.runtime.sendMessage(
                  { type: 'FOOTPRINTS_GET_OTHER_TAB_WITH_STEPS', tabId: Number(tabId) },
                  (peerRes) => {
                    if (chrome.runtime.lastError) {
                      statsEl.textContent = 'No actions taken.';
                      statsEl.hidden = false;
                      return;
                    }
                    const peer = peerRes && peerRes.peer;
                    if (peer && peer.tabId != null && peer.count) {
                      statsEl.textContent =
                        'No actions on this tab. Open "' +
                        peer.title +
                        '" to retrace steps saved on that tab.';
                      statsEl.hidden = false;
                      peerTabRow.hidden = false;
                      peerTabJump.dataset.tabId = String(peer.tabId);
                      peerTabJump.dataset.windowId =
                        peer.windowId != null ? String(peer.windowId) : '';
                    } else {
                      statsEl.textContent = 'No actions taken.';
                      statsEl.hidden = false;
                    }
                  }
                );
              } else {
                statsEl.textContent = 'No actions taken.';
                statsEl.hidden = false;
              }
            }
          }
        );
      });
    });
  }

  if (peerTabJump) {
    peerTabJump.addEventListener('click', () => {
      const tid = Number(peerTabJump.dataset.tabId);
      const wid = Number(peerTabJump.dataset.windowId);
      if (!Number.isFinite(tid)) return;
      chrome.tabs.update(tid, { active: true }, () => {
        void chrome.runtime.lastError;
        if (Number.isFinite(wid)) {
          chrome.windows.update(wid, { focused: true }, () => {
            void chrome.runtime.lastError;
            window.close();
          });
        } else {
          window.close();
        }
      });
    });
  }

  replayBtn.addEventListener('click', () => {
    showErr('');
    getActiveTab((tab, err) => {
      if (err || !tab.id) {
        showErr(err || 'No tab.');
        return;
      }
      const tabId = tab.id;
      chrome.tabs.sendMessage(tabId, { type: 'FOOTPRINTS_FLUSH_PENDING' }, () => {
        void chrome.runtime.lastError;
        chrome.tabs.sendMessage(
          tabId,
          { type: 'FOOTPRINTS_START_REPLAY', compact: false },
          () => {
            if (chrome.runtime.lastError) {
              showErr(
                'Could not start retrace. Stay on an http(s) page and refresh if you just installed the extension.'
              );
              return;
            }
            window.close();
          }
        );
      });
    });
  });

  (function wireFootprintsSettings() {
    if (
      !settingsBtn ||
      !settingsOverlay ||
      !settingsBackdrop ||
      !settingsClose ||
      !settingsDone ||
      !showLauncherCb ||
      !maxActionsRange ||
      !maxActionsValue
    ) {
      return;
    }

    function clampMaxStored(n) {
      let x = Math.round(Number(n));
      if (!Number.isFinite(x)) x = 4;
      return Math.max(3, Math.min(10, x));
    }

    function updateMaxLabel() {
      maxActionsValue.textContent = String(clampMaxStored(maxActionsRange.value));
    }

    function loadSettingsIntoForm(callback) {
      chrome.storage.local.get(
        {
          [FP_SHOW_FLOATING_WIDGET_KEY]: true,
          [FP_MAX_STORED_ACTIONS_KEY]: 4,
        },
        (r) => {
          if (chrome.runtime.lastError) {
            if (callback) callback();
            return;
          }
          showLauncherCb.checked = r[FP_SHOW_FLOATING_WIDGET_KEY] !== false;
          maxActionsRange.value = String(clampMaxStored(r[FP_MAX_STORED_ACTIONS_KEY]));
          updateMaxLabel();
          if (callback) callback();
        }
      );
    }

    function openSettingsPanel() {
      loadSettingsIntoForm(() => {
        document.documentElement.classList.add('fp-settings-square');
        settingsOverlay.hidden = false;
        settingsOverlay.setAttribute('aria-hidden', 'false');
      });
    }

    function closeSettingsPanel() {
      document.documentElement.classList.remove('fp-settings-square');
      settingsOverlay.hidden = true;
      settingsOverlay.setAttribute('aria-hidden', 'true');
    }

    settingsBtn.addEventListener('click', openSettingsPanel);
    settingsBackdrop.addEventListener('click', closeSettingsPanel);
    settingsClose.addEventListener('click', closeSettingsPanel);
    settingsDone.addEventListener('click', closeSettingsPanel);
    showLauncherCb.addEventListener('change', () => {
      chrome.storage.local.set({ [FP_SHOW_FLOATING_WIDGET_KEY]: showLauncherCb.checked }, () =>
        void chrome.runtime.lastError
      );
    });
    maxActionsRange.addEventListener('input', updateMaxLabel);
    maxActionsRange.addEventListener('change', () => {
      const m = clampMaxStored(maxActionsRange.value);
      maxActionsRange.value = String(m);
      updateMaxLabel();
      chrome.storage.local.set({ [FP_MAX_STORED_ACTIONS_KEY]: m }, () => void chrome.runtime.lastError);
    });
  })();

  if (chrome.storage && chrome.storage.session && chrome.storage.session.onChanged) {
    chrome.storage.session.onChanged.addListener((changes, area) => {
      if (area !== 'session') return;
      const keys = Object.keys(changes);
      if (!keys.some((k) => k.indexOf('footprints_sess_child_open_') === 0)) return;
      getActiveTab((tab, err) => {
        if (err || tab.id == null) return;
        if (!keys.includes('footprints_sess_child_open_' + tab.id)) return;
        refreshCount();
      });
    });
  }

  chrome.storage.local.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.prototype.hasOwnProperty.call(changes, FP_MAX_STORED_ACTIONS_KEY)) {
      refreshCount();
    }
    const keys = Object.keys(changes).filter((k) => k.startsWith('footprints_tab_'));
    if (!keys.length) return;
    // Only refresh if the active page’s bucket changed (avoids races / wrong-tab noise).
    getActiveTab((tab, err) => {
      if (err || tab.id == null) return;
      if (!keys.includes('footprints_tab_' + tab.id)) return;
      refreshCount();
    });
  });

  refreshCount();
})();
