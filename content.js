/**
 * Footprints – content script: capture meaningful interactions, replay overlay.
 * Runs only on http(s) pages per manifest; no chrome:// access.
 */
(function footprintsContent() {
  'use strict';

  const U = FootprintsUtils;
  const { CONFIG, log, warn } = U;

  const getFootprintsAnimal = globalThis.getFootprintsAnimal;
  const FOOTPRINTS_MASCOT_STORAGE_KEY = globalThis.FOOTPRINTS_MASCOT_STORAGE_KEY;
  const FOOTPRINTS_DEFAULT_MASCOT_ID = globalThis.FOOTPRINTS_DEFAULT_MASCOT_ID;

  let cachedMascotId = FOOTPRINTS_DEFAULT_MASCOT_ID;
  let cachedMascotUrl = chrome.runtime.getURL(getFootprintsAnimal(cachedMascotId).path);

  function applyMascotFromStorageRecord(r) {
    const id = (r && r.fpMascotAnimalId) || FOOTPRINTS_DEFAULT_MASCOT_ID;
    const animal = getFootprintsAnimal(id);
    cachedMascotId = animal.id;
    cachedMascotUrl = chrome.runtime.getURL(animal.path);
    const fabImg = document.querySelector('#footprints-floating-bunny .footprints-floating-bunny-img');
    if (fabImg) fabImg.src = cachedMascotUrl;
    const fabBtn = document.querySelector('#footprints-floating-bunny button');
    if (fabBtn) fabBtn.setAttribute('aria-label', 'Retrace with ' + animal.label);
    document.querySelectorAll('.footprints-rabbit-mascot').forEach((el) => {
      if (el.tagName === 'IMG') {
        el.src = cachedMascotUrl;
        el.alt = animal.label + ' guide';
      }
    });
    syncFloatingFabCarrotVisibility();
    syncFloatingFabOwlWormVisibility();
    syncFloatingFabFoxBerryClusterVisibility();
    syncFloatingFabRaccoonTrashWrap();
    syncFloatingFabRaccoonTrashHeapVisibility();
    syncFloatingFabRaccoonLauncherEatingVideoLayer();
    syncFloatingFabBunnyLauncherEatingVideoLayer();
    syncFloatingFabFoxLauncherEatingVideoLayer();
    syncFloatingFabOwlLauncherEatingVideoLayer();
  }

  /** @type {{ x: number, y: number, startTime: number, lastTime: number, count: number, target: Element } | null} */
  let pendingCluster = null;
  let clusterFlushTimer = null;

  let scrollBaseline = window.scrollY;
  let pauseCheckTimer = null;
  let lastMeaningfulActivity = Date.now();

  /** Fewer than this many stored steps on the tab → offer “Take me to opener tab” when we know this tab was opened from a link. */
  const MIN_ACTIONS_FOR_OPENER_TAB_PROMPT = 4;
  const FLOATING_BUNNY_ID = 'footprints-floating-bunny';
  /** Mascot + paw trail during replay; must stack above the FAB (overlay is z-index below launcher). */
  const REPLAY_GUIDE_LAYER_ID = 'footprints-replay-guide-layer';
  /** Cross-page retrace: full-screen exit layer above the FAB. */
  const REPLAY_EXIT_SLIDE_LAYER_ID = 'footprints-replay-exit-slide';
  /**
   * Cross-page re-entry hint for the next page’s intro glide.
   * Must stay in sync with `runReplayCrossPageExitSlideThenNavigate` + FAB arrows:
   * - **Left green arrow** (older step): mascot exits **off the left**; token `fromRight` = next page starts **off the right** and glides in **from the right**.
   * - **Right green arrow** (newer step): exits **off the right**; token `fromLeft` = next page starts **off the left** and glides in **from the left**.
   */
  const REPLAY_CROSS_PAGE_ENTRY_SS_KEY = 'footprintsReplayCrossPageEntry';
  /** Replay guide: intro glide from start → target; linear reads as steady walking. */
  const REPLAY_INTRO_GLIDE_MS = 2600;
  /** Intro from launcher: mascot box is this × the visible FAB icon rect (walk clip reads larger on first glide). */
  const REPLAY_INTRO_FROM_LAUNCHER_MASCOT_SCALE = 1.34;
  /** Cross-page exit: mascot slides off-screen before navigation. */
  const REPLAY_EXIT_SLIDE_MS = 2500;
  /** Extra walk cycles vs. minimum (higher = more restarts per glide; lower = less seam risk). */
  const REPLAY_RACCOON_WALK_LOOP_DENSITY = 1.18;
  /** Bunny retrace walk should read calmer than source clips; <1 slows all bunny directions. */
  const REPLAY_BUNNY_WALK_RATE_SCALE = 0.72;
  /** "Walking away" needs a bit more pace so it does not feel stalled while shrinking. */
  const REPLAY_BUNNY_WALK_AWAY_RATE_SCALE = 0.95;
  /** Raccoon away clip should feel brisker during stretched single-pass replay. */
  const REPLAY_RACCOON_WALK_AWAY_RATE_SCALE = 1.12;
  /** Extra wall-time pad for away pacing so walk does not hit clip tail too early. */
  const REPLAY_RACCOON_WALK_AWAY_RATE_PAD_SEC = 0.45;
  /** Soft-loop: rewind this far before EOF (avoids true `ended` / long decode stall vs. native `loop`). */
  const REPLAY_RACCOON_WALK_SOFT_TAIL_SEC = 0.11;
  /** Loop lands here instead of 0 to skip mushy first frames (seconds). */
  const REPLAY_RACCOON_WALK_SOFT_HEAD_SEC = 0.02;
  /** Fox down-walk (left/right) should loop the full clip (no head/tail skipping). */
  const REPLAY_FOX_DOWN_SOFT_TAIL_SEC = 0;
  const REPLAY_FOX_DOWN_SOFT_HEAD_SEC = 0;
  /** Owl flight soft-loop rewinds earlier to hide the flap seam near clip end. */
  const REPLAY_OWL_FLIGHT_SOFT_TAIL_SEC = 0.2;
  /** Owl flight loop restarts past the opening setup frames for a cleaner seam. */
  const REPLAY_OWL_FLIGHT_SOFT_HEAD_SEC = 0.08;
  const FLOATING_BUNNY_POS_KEY = `footprints_fab_pos_${U.canonicalPageKey(location.href)}`;
  const FLOATING_BUNNY_CHEW_CSS_ID = 'footprints-floating-chewcss';
  /** Circular launcher diameter. */
  /** Circular FAB diameter (grass + mascot). */
  const FLOATING_BUNNY_SIZE_PX = 64;
  /** Hard cap on replay intro guide box edge (hosts with broken layout can report huge FAB icon rects after cross-tab nav). */
  const REPLAY_GUIDE_BOX_MAX_EDGE_PX = Math.ceil(
    FLOATING_BUNNY_SIZE_PX * REPLAY_INTRO_FROM_LAUNCHER_MASCOT_SCALE * 1.35
  );
  /** Ignore FAB icon rects larger than this when matching the guide sprite (broken layout). */
  const REPLAY_LAUNCHER_ICON_RECT_MAX_EDGE_PX = FLOATING_BUNNY_SIZE_PX * 3;
  /** Standalone launcher halo (green glow + depth). */
  const FLOATING_BUNNY_BTN_SHADOW_IDLE =
    '0 0 0 2px rgba(50, 160, 88, 0.5), 0 0 14px 5px rgba(50, 160, 88, 0.42), 0 0 32px 10px rgba(50, 160, 88, 0.2), 0 8px 24px rgba(15,23,42,0.28), inset 0 0 0 1px rgba(220,245,230,0.55)';
  /** Mascot circle inside retrace pill card (outer glow comes from the card). */
  const FLOATING_BUNNY_BTN_SHADOW_RETRACE_CARD =
    '0 3px 14px rgba(15,23,42,0.22), 0 0 0 2px rgba(50, 160, 88, 0.55), inset 0 0 0 1px rgba(220,245,230,0.55)';
  /** After last scroll event, remove chew animation once quiet this long. */
  const FLOATING_CHEW_SCROLL_IDLE_MS = 320;
  /**
   * Bunny retrace walk clips (H.264 `.m4v`): horizontal uses walk-right (mirrored for left),
   * steep downward uses walking-straight, steep upward uses walking-away.
   */
  const FP_BUNNY_WALK_RIGHT_M4V = 'videos/bunny-walk-right.m4v';
  const FP_BUNNY_WALK_STRAIGHT_M4V = 'videos/bunny-walk-straight.m4v';
  const FP_BUNNY_WALK_AWAY_M4V = 'videos/bunny-walk-away.m4v';
  /** Bunny FAB: H.264 MPEG-4 scroll-chew clip, keyed to transparent canvas like raccoon launcher. */
  const FP_BUNNY_LAUNCHER_EATING = 'videos/bunny-eating.m4v';
  /** Fox retrace walk: mostly-down = straight; up-page + leftward (dvx < 0) = away-left; up + right = away-right. */
  const FP_FOX_WALK_STRAIGHT_M4V = 'videos/fox-walk-straight.m4v';
  /** Fox retrace walk (down-page): use dedicated left clip; mirror for rightward travel. */
  const FP_FOX_WALK_LEFT_M4V = 'videos/fox-walk-left.m4v';
  const FP_FOX_WALK_AWAY_LEFT_M4V = 'videos/fox-walk-away-left.m4v';
  const FP_FOX_WALK_AWAY_RIGHT_M4V = 'videos/fox-walk-away-right.m4v';
  /** Fox FAB: H.264 MPEG-4 scroll-chew clip, keyed to transparent canvas like bunny/raccoon. */
  const FP_FOX_LAUNCHER_EATING = 'videos/fox-eating.m4v';
  /** Owl retrace: one left-flying encode; rightward travel mirrors it. Up-page travel uses away clip. */
  const FP_OWL_FLY_LEFT_M4V = 'videos/owl-flying-left.m4v';
  const FP_OWL_FLY_AWAY_M4V = 'videos/owl-flying-away.m4v';
  /** Owl FAB scroll-chew clip. */
  const FP_OWL_LAUNCHER_EATING = 'videos/owl-eating.m4v';
  /** Fox retrace clips render with extra padding; keep all fox walk variants at the same larger size. */
  const FP_FOX_RETRACE_VIDEO_SCALE = 1.52;
  /** Down-page fox left/right clips: bump slightly larger than other fox retrace clips. */
  const FP_FOX_RETRACE_DOWN_VIDEO_SCALE = 1.6;
  /** Down-page fox left/right clips: nudge into the center of the glow. */
  const FP_FOX_RETRACE_DOWN_VIDEO_OFFSET_X_PX = 0;
  const FP_FOX_RETRACE_DOWN_VIDEO_OFFSET_Y_PX = 18;
  /** Down-page fox left clip: slight extra lift vs right. */
  const FP_FOX_RETRACE_DOWN_LEFT_EXTRA_OFFSET_Y_PX = -22;
  /** Down-page fox left clip: slight right nudge vs right clip center. */
  const FP_FOX_RETRACE_DOWN_LEFT_EXTRA_OFFSET_X_PX = -4;
  /** Down-page fox right clip (mirrored): slight extra lift to center in glow. */
  const FP_FOX_RETRACE_DOWN_RIGHT_EXTRA_OFFSET_Y_PX = -18;
  /** Push fox retrace walk slightly downward so it sits centered in the glow. */
  const FP_FOX_RETRACE_VIDEO_OFFSET_Y_PX = 12;
  /** First retrace intro from the launcher: lift fox slightly more so it does not start too low. */
  const FP_FOX_RETRACE_INTRO_EXTRA_LIFT_PX = 20;
/** Owl side-flight retrace clip scale. */
const FP_OWL_RETRACE_LEFT_VIDEO_SCALE = 1.58;
/** Owl away-flight retrace clip scale. */
const FP_OWL_RETRACE_AWAY_VIDEO_SCALE = 1.98;
/** Push side-flight owl slightly downward to sit in the glow. */
const FP_OWL_RETRACE_LEFT_VIDEO_OFFSET_Y_PX = 18;
/** Push away-flight owl farther downward so it centers in the glow. */
const FP_OWL_RETRACE_AWAY_VIDEO_OFFSET_Y_PX = 28;
/** Nudge away-flight owl slightly left to center it in the glow. */
const FP_OWL_RETRACE_AWAY_VIDEO_OFFSET_X_PX = -8;
  /**
   * Raccoon retrace / cross-page exit walk: one H.264 `.m4v` (walk-right). Separate left/away encodes looped worse;
   * leftward travel uses the same file with `scaleX(-1)` on the mascot root (see `createRaccoonRetraceVideoMascot`).
   */
  const FP_RACCOON_WALK_M4V = 'videos/raccoon-walk-right.m4v';
  /** Optional dedicated raccoon away clip (used for upward travel when bundled). */
  const FP_RACCOON_WALK_AWAY_M4V = 'videos/raccoon-walk-away.m4v';
  /** Raccoon retrace walk clips: slight size bump to better fill the glow. */
  const FP_RACCOON_RETRACE_VIDEO_SCALE = 1.08;
  /** Raccoon FAB: H.264 MPEG-4; replaces bob/trash scroll animation (see floating-bunny-chew.css). */
  const FP_RACCOON_LAUNCHER_EATING = 'videos/raccoon-eating.m4v';
  /** Euclidean RGB distance (0–~441): pixels within this of perimeter-estimated bg become transparent. */
  const FP_RACCOON_LAUNCHER_MATTE_COLOR_DIST = 44;
  /** Extra distance for soft fringe (same units as above). */
  const FP_RACCOON_LAUNCHER_MATTE_COLOR_FEATHER = 32;
  const FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE = 256;
  /** Fallback if background estimate fails (BT.601 luma, 0–255). */
  const FP_RACCOON_LAUNCHER_MATTE_LUMA_THRESHOLD = 248;
  const FP_RACCOON_LAUNCHER_MATTE_LUMA_FEATHER = 14;
  /**
   * Fox clips have brighter internal whites (eyes/fur), so use a gentler key than bunny/raccoon
   * and avoid the aggressive cartoon backdrop cleanup pass.
   */
  const FP_FOX_MATTE_COLOR_DIST = 30;
  const FP_FOX_MATTE_COLOR_FEATHER = 14;
  const FP_FOX_MATTE_LUMA_THRESHOLD = 252;
  const FP_FOX_MATTE_LUMA_FEATHER = 8;
  /** Owl clips: wide perimeter pull + HSV/neighbor passes strip stubborn green mat in canvas. */
  const FP_OWL_MATTE_COLOR_DIST = 44;
  const FP_OWL_MATTE_COLOR_FEATHER = 8;
  const FP_OWL_MATTE_LUMA_THRESHOLD = 252;
  const FP_OWL_MATTE_LUMA_FEATHER = 8;
  let floatingChewIdleTimer = 0;
  let fpRaccoonEatingMatteRaf = 0;
  let fpBunnyEatingMatteRaf = 0;
  let fpFoxEatingMatteRaf = 0;
  let fpRaccoonWalkAwayAvailable = false;
  let fpRaccoonWalkAwayProbeStarted = false;
  let fpFoxWalkDownLeftAvailable = false;
  let fpFoxWalkDownProbeStarted = false;
  const FP_SHOW_FLOATING_WIDGET_KEY = 'fpShowFloatingWidget';
  const FP_MAX_STORED_ACTIONS_KEY = 'fpMaxStoredActions';
  /** When false, the circular launcher is not shown; retrace still runs from the popup or keyboard shortcut. */
  let cachedShowFloatingWidget = true;

  /** While hop replay is showing: call to stop (widget / shortcut / popup). Cleared when overlay ends. */
  let stopActiveFootprintsReplay = null;

  const FP_SESSION_OPENER_KEY = 'footprints_pending_opener_gate';

  /** @type {null | { actions: object[], index: number, originHref: string, originNorm: string, compact: boolean, stayOnPage: boolean, offerOpener: boolean, openerCtx: object | null, preReplayFabPos: null | { left: number, top: number } }} */
  let multiPageReplay = null;

  /** @type {null | ((urgent: boolean) => void)} */
  let activeReplayOverlayCleanup = null;

  /** Last displayed guide position from retrace, used as the start for the next retrace on this page. */
  let lastReplayGuideDocPoint = null;

  /** Monotonic id for replay runs on this page; blocks stale async cleanup from older runs. */
  let replayRunId = 0;

  /**
   * Set before cross-page navigation: `'left'` = user pressed the **left** green arrow (older step);
   * `'right'` = **right** green arrow (newer step). Drives exit slide direction and `REPLAY_CROSS_PAGE_ENTRY_SS_KEY`.
   */
  let pendingReplayCrossPageArrow = null;

  /**
   * After at least one guide position on this page, slide the mascot off-screen, then navigate.
   * `arrow === 'left'`: exit **left** (−x); next page stores `fromRight` (re-enter **from the right**).
   * `arrow === 'right'`: exit **right**; next page stores `fromLeft` (re-enter **from the left**).
   */
  function runReplayCrossPageExitSlideThenNavigate(pt, assignUrl, arrow) {
    document.getElementById(REPLAY_EXIT_SLIDE_LAYER_ID)?.remove();
    const layer = document.createElement('div');
    layer.id = REPLAY_EXIT_SLIDE_LAYER_ID;
    layer.setAttribute('data-footprints-replay-exit', '1');
    layer.style.cssText =
      'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    const st = document.createElement('style');
    st.textContent =
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' .footprints-rabbit-wrap{position:absolute!important;width:76px!important;height:76px!important;' +
      'margin-left:-38px!important;margin-top:-38px!important;pointer-events:none!important;' +
      'transform:translateY(-52px)!important;border:none!important;background:transparent!important;}' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' video.footprints-raccoon-retrace-video,' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' video.footprints-bunny-retrace-video,' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' video.footprints-fox-retrace-video,' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' canvas.footprints-bunny-retrace-video,' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' canvas.footprints-raccoon-retrace-video,' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' canvas.footprints-fox-retrace-video{width:100%!important;height:100%!important;object-fit:contain!important;' +
      'object-position:center bottom!important;display:block!important;border:none!important;outline:none!important;' +
      'box-shadow:none!important;background:transparent!important;background-color:transparent!important;' +
      'pointer-events:none!important;mix-blend-mode:multiply!important;' +
      'filter:drop-shadow(0 2px 5px rgba(0,0,0,0.35)) drop-shadow(0 0 12px rgba(42,122,78,0.38))!important;' +
      '-webkit-filter:drop-shadow(0 2px 5px rgba(0,0,0,0.35)) drop-shadow(0 0 12px rgba(42,122,78,0.38))!important;}' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' video.footprints-fox-retrace-video,' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' canvas.footprints-fox-retrace-video{mix-blend-mode:normal!important;}' +
      '#' +
      REPLAY_EXIT_SLIDE_LAYER_ID +
      ' img.footprints-rabbit-mascot{width:100%!important;height:100%!important;object-fit:contain!important;' +
      'object-position:center bottom!important;display:block!important;' +
      'filter:' +
      'drop-shadow(1px 0 0 rgba(255,255,255,0.84)) drop-shadow(-1px 0 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 1px 0 rgba(255,255,255,0.84)) drop-shadow(0 -1px 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 0 40px rgba(90,195,130,0.9)) drop-shadow(0 0 86px rgba(90,195,130,0.78))!important;' +
      '-webkit-filter:' +
      'drop-shadow(1px 0 0 rgba(255,255,255,0.84)) drop-shadow(-1px 0 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 1px 0 rgba(255,255,255,0.84)) drop-shadow(0 -1px 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 0 40px rgba(90,195,130,0.9)) drop-shadow(0 0 86px rgba(90,195,130,0.78))!important;}';
    layer.appendChild(st);
    const wrap = document.createElement('div');
    wrap.className = 'footprints-rabbit-wrap';
    wrap.style.overflow = 'visible';
    wrap.style.zIndex = '2';
    const footprintsLayer = document.createElement('div');
    footprintsLayer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:1;';
    layer.appendChild(footprintsLayer);
    wrap.appendChild(createRetraceMascotHalo());
    const exitLeft = arrow !== 'right';
    const exitMascot = createRabbitHopMascot({
      retraceExitArrow: exitLeft ? 'left' : 'right',
    });
    applyRetraceMascotGlow(exitMascot);
    if (
      exitMascot.tagName === 'VIDEO' ||
      isRaccoonRetraceWalkStack(exitMascot) ||
      isBunnyRetraceWalkStack(exitMascot) ||
      isFoxRetraceWalkStack(exitMascot)
    ) {
      syncRaccoonRetraceWalkClipToGlideDuration(exitMascot, REPLAY_EXIT_SLIDE_MS);
    }
    wrap.appendChild(exitMascot);
    wrap.style.transition = 'none';
    layer.appendChild(wrap);
    const fabEl = document.getElementById(FLOATING_BUNNY_ID);
    if (fabEl && fabEl.parentNode) {
      fabEl.parentNode.insertBefore(layer, fabEl.nextSibling);
    } else {
      (document.body || document.documentElement).appendChild(layer);
    }
    const sx = pt.x - window.scrollX;
    const sy = pt.y - window.scrollY;
    wrap.style.left = `${sx}px`;
    wrap.style.top = `${sy}px`;
    const exitMs = REPLAY_EXIT_SLIDE_MS;
    const endX = exitLeft ? -140 : window.innerWidth + 140;
    const entryToken = exitLeft ? 'fromRight' : 'fromLeft';
    try {
      sessionStorage.setItem(REPLAY_CROSS_PAGE_ENTRY_SS_KEY, entryToken);
    } catch (e) {
      /* ignore */
    }
    let finished = false;
    let exitTrailRaf = 0;
    let exitTrailPrev = null;
    let exitTrailLastStamp = null;
    let exitTrailSide = -1;
    function stopExitTrailLoop() {
      if (exitTrailRaf) {
        cancelAnimationFrame(exitTrailRaf);
        exitTrailRaf = 0;
      }
    }
    function spawnExitTrailPrint(vx, vy, rotDeg) {
      const wrapEl = document.createElement('div');
      wrapEl.className = 'footprints-trail-wrap';
      wrapEl.style.cssText =
        'position:absolute;left:' +
        vx +
        'px;top:' +
        vy +
        'px;pointer-events:none;transform:translate(-50%,-50%) rotate(' +
        rotDeg +
        'deg) scale(0.88);';
      const inner = document.createElement('div');
      inner.className = 'footprints-trail-inner footprints-trail-fade';
      inner.innerHTML = footprintSvgTrail();
      inner.style.cssText =
        'width:17px;height:23px;opacity:0.95;transform-origin:50% 82%;' +
        'animation:footprints-replay-trail-fade 0.45s ease-out 1.5s forwards;';
      wrapEl.appendChild(inner);
      footprintsLayer.appendChild(wrapEl);
      inner.addEventListener(
        'animationend',
        () => {
          wrapEl.remove();
        },
        { once: true },
      );
      window.setTimeout(() => {
        wrapEl.remove();
      }, 2050);
    }
    function spawnExitTrailBehindPastAnchor(pastX, pastY, towardX, towardY) {
      const dx = towardX - pastX;
      const dy = towardY - pastY;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.2) return;
      const ux = dx / dist;
      const uy = dy / dist;
      const rotDeg = (Math.atan2(uy, ux) * 180) / Math.PI + 90;
      const perpx = -uy;
      const perpy = ux;
      const back = 12;
      const px = pastX - ux * back + perpx * exitTrailSide * 4;
      const py = pastY - uy * back + perpy * exitTrailSide * 4;
      spawnExitTrailPrint(px, py, rotDeg + exitTrailSide * 3);
      exitTrailSide *= -1;
    }
    function readExitMascotAnchorVp() {
      const r = wrap.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.86 };
    }
    function exitTrailFrame() {
      if (finished) {
        exitTrailRaf = 0;
        return;
      }
      const cur = readExitMascotAnchorVp();
      if (exitTrailPrev) {
        if (!exitTrailLastStamp) {
          exitTrailLastStamp = { x: exitTrailPrev.x, y: exitTrailPrev.y };
        }
        const sdx = cur.x - exitTrailLastStamp.x;
        const sdy = cur.y - exitTrailLastStamp.y;
        if (sdx * sdx + sdy * sdy >= 38 * 38) {
          spawnExitTrailBehindPastAnchor(exitTrailLastStamp.x, exitTrailLastStamp.y, cur.x, cur.y);
          exitTrailLastStamp = { x: cur.x, y: cur.y };
        }
      }
      exitTrailPrev = cur;
      exitTrailRaf = window.requestAnimationFrame(exitTrailFrame);
    }
    function cleanupAndAssign() {
      if (finished) return;
      finished = true;
      stopExitTrailLoop();
      wrap.removeEventListener('transitionend', onTransEnd);
      pauseRaccoonRetraceWalkVideos(exitMascot);
      disposeFootprintsWalkMatteDecoders(exitMascot);
      layer.remove();
      try {
        sessionStorage.setItem(REPLAY_CROSS_PAGE_ENTRY_SS_KEY, entryToken);
      } catch (e) {
        /* ignore */
      }
      assignUrl();
    }
    function onTransEnd(ev) {
      if (ev.target !== wrap) return;
      if (ev.propertyName !== 'left' && ev.propertyName !== 'top') return;
      cleanupAndAssign();
    }
    wrap.addEventListener('transitionend', onTransEnd);
    window.setTimeout(cleanupAndAssign, exitMs + 480);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (
          exitMascot &&
          (exitMascot.tagName === 'VIDEO' ||
            isRaccoonRetraceWalkStack(exitMascot) ||
            isBunnyRetraceWalkStack(exitMascot) ||
            isFoxRetraceWalkStack(exitMascot))
        ) {
          if (isRaccoonRetraceWalkStack(exitMascot)) {
            const layers = exitMascot.querySelectorAll(':scope > .fp-raccoon-walk-ping-layer');
            const va = layers[0] && fpRaccoonWalkLayerDecoderVideo(layers[0]);
            const vb = layers[1] && fpRaccoonWalkLayerDecoderVideo(layers[1]);
            if (va) va.currentTime = 0;
            if (vb) {
              vb.currentTime = REPLAY_RACCOON_WALK_SOFT_HEAD_SEC;
              vb.pause();
            }
            if (va) {
              const pr = va.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          } else if (isBunnyRetraceWalkStack(exitMascot)) {
            const walkVid = fpFirstWalkMatteVideo(exitMascot, 'video.fp-bunny-walk-matte-src');
            if (walkVid) {
              walkVid.currentTime = 0;
              const pr = walkVid.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          } else if (isFoxRetraceWalkStack(exitMascot)) {
            const walkVid = fpFirstWalkMatteVideo(exitMascot, 'video.fp-fox-walk-matte-src');
            if (walkVid) {
              walkVid.currentTime = 0;
              const pr = walkVid.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          } else {
            exitMascot.currentTime = 0;
            const pr = exitMascot.play();
            if (pr && typeof pr.catch === 'function') pr.catch(() => {});
          }
        }
        exitTrailRaf = window.requestAnimationFrame(exitTrailFrame);
        wrap.style.transition = `left ${exitMs}ms linear, top ${exitMs}ms linear`;
        wrap.style.left = `${endX}px`;
        wrap.style.top = `${sy}px`;
      });
    });
  }

  function registerReplayOverlayCleanup(fn) {
    activeReplayOverlayCleanup = typeof fn === 'function' ? fn : null;
  }

  function runReplayOverlayCleanup(urgent) {
    const fn = activeReplayOverlayCleanup;
    activeReplayOverlayCleanup = null;
    if (typeof fn === 'function') {
      try {
        fn(!!urgent);
      } catch (e) {
        warn('replay cleanup', e);
      }
    }
  }

  function forceRemoveReplayOverlayUi() {
    document.removeEventListener('pointerdown', onDocumentPointerDownStopReplay, true);
    document.removeEventListener('keydown', onReplayStepArrowKeydown, true);
    document.getElementById('footprints-overlay-root')?.remove();
    document.getElementById(REPLAY_GUIDE_LAYER_ID)?.remove();
    document.getElementById(REPLAY_EXIT_SLIDE_LAYER_ID)?.remove();
  }

  function teardownReplayUi() {
    runReplayOverlayCleanup(true);
    forceRemoveReplayOverlayUi();
    removeFloatingBunnyReplayControls();
    setFloatingFabMascotVisibleInLauncher(true);
    resetFloatingLauncherChewState();
  }

  function restoreLauncherAfterReplayStop(pinFab) {
    if (!cachedShowFloatingWidget) {
      removeFloatingLauncherDom();
      return;
    }
    if (pinFab) {
      const pos = clampFloatingBunny(pinFab.left, pinFab.top, FLOATING_BUNNY_SIZE_PX);
      saveFloatingBunnyPos(pos.left, pos.top);
    }
    ensureFloatingBunny();
  }

  function invokeStopActiveFootprintsReplay() {
    const fn = stopActiveFootprintsReplay;
    stopActiveFootprintsReplay = null;
    let threw = false;
    if (typeof fn === 'function') {
      try {
        fn();
      } catch (e) {
        warn('stop replay', e);
        threw = true;
      }
      if (!threw) return;
    }
    /*
     * Failsafe: if replay UI/session still exists (or callback threw), force-abort.
     * This prevents "stuck replay" when callback wiring desyncs.
     */
    if (
      threw ||
      multiPageReplay ||
      document.getElementById('footprints-overlay-root') ||
      document.getElementById(REPLAY_GUIDE_LAYER_ID)
    ) {
      fallbackAbortReplaySession();
    }
  }

  function fallbackAbortReplaySession() {
    const m = multiPageReplay;
    const replayRunIdAtStop =
      m && Number.isFinite(m.replayRunId) ? m.replayRunId : replayRunId;
    const hereNorm = U.canonicalPageKey(location.href);
    const leaveReplayPage =
      m &&
      !m.stayOnPage &&
      shouldNavigateToReplayStartUrl(m.originNorm, m.originHref, hereNorm);
    const originHref = leaveReplayPage ? m.originHref : '';
    const preFab = leaveReplayPage ? m.preReplayFabPos : null;
    const pinFab =
      m &&
      m.preReplayFabPos &&
      Number.isFinite(m.preReplayFabPos.left) &&
      Number.isFinite(m.preReplayFabPos.top)
        ? { left: m.preReplayFabPos.left, top: m.preReplayFabPos.top }
        : null;
    teardownReplayUi();
    if (leaveReplayPage) {
      abortMultiPageReplay(() => {
        if (!cachedShowFloatingWidget) removeFloatingLauncherDom();
        navigateToReplayStartUrl(originHref, preFab);
      }, replayRunIdAtStop);
      return;
    }
    abortMultiPageReplay(undefined, replayRunIdAtStop);
    restoreLauncherAfterReplayStop(pinFab);
  }

  function isFootprintsReplayRunning() {
    return typeof stopActiveFootprintsReplay === 'function';
  }

  function isPointerEventOnReplayUiControl(ev) {
    const raw = ev.target;
    const targetEl = raw && raw.nodeType === Node.TEXT_NODE ? raw.parentElement : raw;
    if (!targetEl || typeof targetEl.closest !== 'function') return false;
    return !!targetEl.closest(
      '#footprints-overlay-root .footprints-dismiss, ' +
        '#footprints-navigate-gate button, ' +
        '#footprints-opener-gate button, ' +
        '#footprints-link-hint-root .footprints-dismiss'
    );
  }

  /** True if the pointer event belongs to the floating launcher (mascot, arrows, Stay), including when hit-testing sets target outside the FAB. */
  function isPointerEventOnFloatingLauncher(ev) {
    const fab = document.getElementById(FLOATING_BUNNY_ID);
    if (!fab) return false;
    const t = ev.target;
    if (t && fab.contains(t)) return true;
    if (typeof ev.composedPath === 'function') {
      const path = ev.composedPath();
      for (let i = 0; i < path.length; i++) {
        if (path[i] === fab) return true;
      }
    }
    return false;
  }

  /** Any press on the page stops hop replay; FAB subtree is excluded (capture phase needs composedPath for Stay / card edges). */
  function onDocumentPointerDownStopReplay(ev) {
    if (!isFootprintsReplayRunning() && !multiPageReplay) return;
    if (isPointerEventOnFloatingLauncher(ev)) return;
    if (isPointerEventOnReplayUiControl(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    invokeStopActiveFootprintsReplay();
  }

  /** Replay keyboard controls: Left/Right arrows navigate steps; Escape stops retrace. */
  function onReplayStepArrowKeydown(ev) {
    if (!multiPageReplay && !isFootprintsReplayRunning()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      invokeStopActiveFootprintsReplay();
      return;
    }
    const t = ev.target;
    if (t && t.nodeType === 1 && typeof t.closest === 'function') {
      if (t.closest('input, textarea, select')) return;
      const ce = t.closest('[contenteditable]');
      if (ce && ce.getAttribute('contenteditable') !== 'false') return;
    }
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      ev.stopPropagation();
      advanceMultiPageReplayManual();
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      ev.stopPropagation();
      retreatMultiPageReplay();
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging & storage (per-tab via background; survives refresh)
  // ---------------------------------------------------------------------------

  function sendAction(action, onDone) {
    if (!tabForegroundForLogging()) {
      if (onDone) onDone();
      return;
    }
    chrome.runtime.sendMessage({ type: 'FOOTPRINTS_APPEND_ACTION', action }, (res) => {
      if (chrome.runtime.lastError) {
        warn('sendAction', chrome.runtime.lastError.message);
        if (onDone) onDone();
        return;
      }
      if (!res || !res.ok) warn('sendAction', res);
      if (onDone) onDone();
    });
  }

  function getActionsFromBg(callback) {
    chrome.runtime.sendMessage({ type: 'FOOTPRINTS_GET_ACTIONS' }, (res) => {
      if (chrome.runtime.lastError) {
        warn('getActions', chrome.runtime.lastError.message);
        callback([]);
        return;
      }
      callback((res && res.actions) || []);
    });
  }

  function getChildOpenContext(callback) {
    chrome.runtime.sendMessage({ type: 'FOOTPRINTS_GET_CHILD_OPEN_CONTEXT' }, (res) => {
      if (chrome.runtime.lastError) {
        callback(null);
        return;
      }
      if (res && res.ok && res.hasContext && res.openerTabId != null) {
        callback({ openerTabId: res.openerTabId, anchor: res.anchor });
      } else {
        callback(null);
      }
    });
  }

  function linkOpensNewTab(anchorEl, ev) {
    if (!anchorEl || anchorEl.tagName !== 'A' || !anchorEl.getAttribute('href')) return false;
    const tgt = (anchorEl.getAttribute('target') || '').toLowerCase();
    if (tgt === '_blank') return true;
    if (ev.metaKey || ev.ctrlKey) return true;
    return false;
  }

  function fpCssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function buildElementCssPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let cur = el;
    let hops = 0;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && hops < 10) {
      const tag = (cur.tagName || '').toLowerCase();
      if (!tag) break;
      if (cur.id) {
        parts.unshift(`${tag}#${fpCssEscape(cur.id)}`);
        break;
      }
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if ((sib.tagName || '').toLowerCase() === tag) idx += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      if (cur === document.body) break;
      cur = cur.parentElement;
      hops += 1;
    }
    return parts.join(' > ');
  }

  function buildNewTabAnchorLocator(a) {
    if (!a) return null;
    let hrefRaw = '';
    try {
      hrefRaw = normalizeHrefForPage(a.href || '');
    } catch (e) {
      hrefRaw = '';
    }
    const hrefKey = hrefRaw ? U.canonicalPageKey(hrefRaw) : '';
    let sameHrefIndex = -1;
    if (hrefKey) {
      try {
        const links = document.querySelectorAll('a[href]');
        let n = 0;
        for (let i = 0; i < links.length; i++) {
          const linkEl = links[i];
          let key = '';
          try {
            key = U.canonicalPageKey(normalizeHrefForPage(linkEl.href || ''));
          } catch (e) {
            key = '';
          }
          if (key !== hrefKey) continue;
          if (linkEl === a) {
            sameHrefIndex = n;
            break;
          }
          n += 1;
        }
      } catch (e) {
        sameHrefIndex = -1;
      }
    }
    const textRaw = String(a.innerText || a.textContent || '')
      .trim()
      .replace(/\s+/g, ' ');
    return {
      hrefKey: hrefKey || undefined,
      hrefRaw: hrefRaw || undefined,
      sameHrefIndex: sameHrefIndex >= 0 ? sameHrefIndex : undefined,
      cssPath: buildElementCssPath(a) || undefined,
      text: textRaw ? textRaw.slice(0, 180) : undefined,
      title: (a.getAttribute('title') || '').trim() || undefined,
      ariaLabel: (a.getAttribute('aria-label') || '').trim() || undefined,
    };
  }

  function registerNewTabAnchorFromLink(a, ev) {
    if (!tabForegroundForLogging()) return;
    try {
      const desc = U.buildElementDescriptor(a);
      const locator = buildNewTabAnchorLocator(a);
      let linkHref = '';
      try {
        linkHref = a.href || '';
      } catch (e) {
        /* ignore */
      }
      chrome.runtime.sendMessage({
        type: 'FOOTPRINTS_REGISTER_NEW_TAB_ANCHOR',
        anchor: {
          descriptor: desc || undefined,
          linkHref: linkHref || undefined,
          linkLocator: locator || undefined,
          x: ev.clientX,
          y: ev.clientY,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          pageUrl: location.href,
        },
      });
    } catch (e) {
      warn('registerNewTabAnchor', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Click clustering
  // ---------------------------------------------------------------------------

  /**
   * @param {(() => void) | undefined} onDone Called after background has stored the action (or nothing to flush).
   */
  function flushCluster(onDone) {
    clusterFlushTimer = null;
    if (!pendingCluster) {
      if (onDone) onDone();
      return;
    }
    if (!tabForegroundForLogging()) {
      if (onDone) onDone();
      return;
    }
    const c = pendingCluster;
    pendingCluster = null;
    const desc = U.buildElementDescriptor(c.target);
    const action = {
      type: 'click',
      x: c.x,
      y: c.y,
      timestamp: Date.now(),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageUrl: location.href,
      descriptor: desc || undefined,
    };
    try {
      const t = c.target;
      if (t && t.tagName === 'A' && t.getAttribute('href')) {
        action.linkHref = t.href;
      }
    } catch (e) {
      /* ignore */
    }
    log('cluster', 'flushed click @', Math.round(c.x), Math.round(c.y));
    sendAction(action, () => {
      bumpMeaningfulActivity();
      if (onDone) onDone();
    });
  }

  function scheduleClusterFlush() {
    if (clusterFlushTimer) clearTimeout(clusterFlushTimer);
    clusterFlushTimer = setTimeout(() => {
      clusterFlushTimer = null;
      if (!tabForegroundForLogging()) return;
      flushCluster();
    }, CONFIG.CLICK_CLUSTER_TIME_MS);
  }

  /**
   * Commit a pending click cluster immediately (used when focus leaves the page).
   * Otherwise opening the extension popup within 2s of a click leaves count at 0.
   */
  function flushPendingClusterNow() {
    if (clusterFlushTimer) {
      clearTimeout(clusterFlushTimer);
      clusterFlushTimer = null;
    }
    if (pendingCluster && tabForegroundForLogging()) {
      flushCluster();
    }
  }

  /**
   * Only count clicks on obvious interactive elements (not raw page chrome).
   */
  function meaningfulClickElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.closest('.footprints-root') || el.closest(`#${FLOATING_BUNNY_ID}`)) {
      return null;
    }
    if (el.closest('input[type="password"]')) return null; // never treat password fields as tracked targets
    const hit = el.closest(
      [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'summary',
        'label',
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[contenteditable]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(', ')
    );
    return hit || null;
  }

  /**
   * Real mouse clicks focus <a href> and leave Chrome’s blue focus ring; blur next frame without blocking navigation.
   */
  function blurAnchorAfterMouseClickIfNeeded(trackedTarget, ev) {
    if (!trackedTarget || !ev || ev.detail <= 0) return;
    const a =
      trackedTarget.tagName === 'A' && trackedTarget.hasAttribute('href')
        ? trackedTarget
        : trackedTarget.closest && trackedTarget.closest('a[href]');
    if (!a) return;
    requestAnimationFrame(() => {
      try {
        if (document.activeElement === a && typeof a.blur === 'function') a.blur();
      } catch (e) {
        /* ignore */
      }
    });
  }

  function onClickCapture(ev) {
    if (ev.button !== 0) return;
    if (!tabForegroundForLogging()) return;
    const raw = ev.target;
    const el =
      raw && raw.nodeType === Node.TEXT_NODE ? raw.parentElement : raw;
    const link = el && el.closest && el.closest('a[href]');
    if (link && linkOpensNewTab(link, ev)) {
      registerNewTabAnchorFromLink(link, ev);
    }
    const t = meaningfulClickElement(el);
    if (!t) return;

    const x = ev.clientX;
    const y = ev.clientY;
    const now = Date.now();

    if (pendingCluster && U.isInCluster(pendingCluster, x, y, now)) {
      U.mergeIntoCluster(pendingCluster, x, y);
      pendingCluster.target = t;
      scheduleClusterFlush();
      blurAnchorAfterMouseClickIfNeeded(t, ev);
      return;
    }

    if (pendingCluster) flushCluster();

    pendingCluster = U.startCluster(x, y);
    pendingCluster.target = t;
    scheduleClusterFlush();
    blurAnchorAfterMouseClickIfNeeded(t, ev);
  }

  // ---------------------------------------------------------------------------
  // Pause detection (LONG_PAUSE_MS); small scroll ignored
  // ---------------------------------------------------------------------------

  function tabForegroundForLogging() {
    return !document.hidden;
  }

  function cancelPauseCheck() {
    if (pauseCheckTimer) {
      clearTimeout(pauseCheckTimer);
      pauseCheckTimer = null;
    }
  }

  function bumpMeaningfulActivity() {
    lastMeaningfulActivity = Date.now();
    scrollBaseline = window.scrollY;
    schedulePauseCheck();
  }

  function schedulePauseCheck() {
    cancelPauseCheck();
    if (!tabForegroundForLogging()) return;
    pauseCheckTimer = setTimeout(checkLongPause, CONFIG.LONG_PAUSE_MS);
  }

  function checkLongPause() {
    pauseCheckTimer = null;
    if (!tabForegroundForLogging()) return;
    const idleFor = Date.now() - lastMeaningfulActivity;
    if (idleFor < CONFIG.LONG_PAUSE_MS) {
      schedulePauseCheck();
      return;
    }
    const action = {
      type: 'pause',
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
      timestamp: Date.now(),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageUrl: location.href,
    };
    log('pause', 'recorded long pause');
    sendAction(action);
    lastMeaningfulActivity = Date.now();
    schedulePauseCheck();
  }

  function onScroll() {
    if (!tabForegroundForLogging()) return;
    /*
     * Always run stale cleanup before the replay-ui gate. Otherwise a stuck overlay/exit node
     * can keep `isReplayUiMounted()` true forever while cleanup never runs (deadlock).
     */
    clearStaleReplayStateForLauncherChew();
    if (isReplayUiMounted()) return;
    pulseFloatingBunnyChewWithScroll();
    const dy = Math.abs(window.scrollY - scrollBaseline);
    if (dy >= CONFIG.MIN_SCROLL_IGNORE_PX) {
      log('scroll', 'meaningful', dy, 'px');
      bumpMeaningfulActivity();
    }
  }

  function onAuxClickCapture(ev) {
    if (ev.button !== 1) return;
    if (!tabForegroundForLogging()) return;
    const raw = ev.target;
    const el =
      raw && raw.nodeType === Node.TEXT_NODE ? raw.parentElement : raw;
    const link = el && el.closest && el.closest('a[href]');
    if (!link) return;
    registerNewTabAnchorFromLink(link, ev);
  }

  // ---------------------------------------------------------------------------
  // Inject overlay CSS once
  // ---------------------------------------------------------------------------

  let overlayCssInjected = false;

  function ensureOverlayCss() {
    if (overlayCssInjected) return;
    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('overlay.css');
      (document.head || document.documentElement).appendChild(link);
      overlayCssInjected = true;
    } catch (e) {
      warn('ensureOverlayCss', e);
    }
  }

  /** Sky + jagged grass strip for the circular floating widget. */
  function createFloatingBunnyGrassLayer() {
    const wrap = document.createElement('div');
    wrap.className = 'fp-floating-grass-wrap';
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1200 220');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'fpFloatingGrassFill');
    grad.setAttribute('x1', '600');
    grad.setAttribute('y1', '220');
    grad.setAttribute('x2', '600');
    grad.setAttribute('y2', '48');
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    [['0%', '#32a058'], ['40%', '#4bbf6e'], ['100%', '#d7ee77']].forEach(([offset, stopColor]) => {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', stopColor);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'url(#fpFloatingGrassFill)');
    path.setAttribute(
      'd',
      'M0 220 L0 118 L18 78 L34 108 L52 65 L68 100 L86 72 L104 112 L122 82 L140 118 L158 68 L176 105 L194 88 L212 58 L230 98 L248 75 L266 108 L284 70 L302 102 L320 85 L338 62 L356 100 L374 78 L392 112 L410 72 L428 95 L446 65 L464 108 L482 80 L500 115 L518 70 L536 98 L554 88 L572 60 L590 102 L608 78 L626 110 L644 72 L662 100 L680 85 L698 55 L716 98 L734 82 L752 112 L770 65 L788 105 L806 75 L824 108 L842 70 L860 100 L878 88 L896 58 L914 105 L932 78 L950 115 L968 68 L986 95 L1004 72 L1022 108 L1040 78 L1058 112 L1076 62 L1094 102 L1112 88 L1130 65 L1148 100 L1166 82 L1184 108 L1200 92 L1200 220 Z'
    );
    svg.appendChild(path);
    wrap.appendChild(svg);
    return wrap;
  }

  /** SVG carrot for the chew scene; gradient ids prefixed for DOM uniqueness. */
  function createFloatingChewCarrot() {
    const root = document.createElement('div');
    root.className = 'fp-chew-carrot';
    root.setAttribute('aria-hidden', 'true');
    const sway = document.createElement('div');
    sway.className = 'fp-chew-carrot-sway';
    sway.innerHTML =
      '<svg class="fp-chew-carrot-svg" viewBox="0 0 100 280" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<linearGradient id="fpChwSkin" x1="10" y1="40" x2="96" y2="200" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0%" stop-color="#ffb85a"/><stop offset="28%" stop-color="#ff8f2e"/>' +
      '<stop offset="55%" stop-color="#f56e18"/><stop offset="100%" stop-color="#c24a0c"/></linearGradient>' +
      '<linearGradient id="fpChwSheen" x1="20" y1="24" x2="72" y2="160" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0%" stop-color="#ffe8b8" stop-opacity="0.55"/><stop offset="45%" stop-color="#fff8ec" stop-opacity="0.12"/>' +
      '<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></linearGradient>' +
      '<linearGradient id="fpChwLeafBright" x1="22" y1="248" x2="78" y2="232" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0%" stop-color="#8fce3a"/><stop offset="100%" stop-color="#5cb832"/></linearGradient>' +
      '<linearGradient id="fpChwLeafShadow" x1="40" y1="270" x2="72" y2="248" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0%" stop-color="#3d7a24"/><stop offset="100%" stop-color="#2a5a18"/></linearGradient>' +
      '</defs>' +
      '<path fill="url(#fpChwSkin)" d="M50 16 C41 18 35 26 33 36 C22 68 19 110 21 148 C23 178 27 202 36 218 C41 223 59 223 64 218 C73 202 77 178 79 148 C81 110 78 68 67 36 C65 26 59 18 50 16 Z"/>' +
      '<path fill="url(#fpChwSheen)" d="M50 16 C41 18 35 26 33 36 C22 68 19 110 21 148 C23 178 27 202 36 218 C41 223 59 223 64 218 C73 202 77 178 79 148 C81 110 78 68 67 36 C65 26 59 18 50 16 Z"/>' +
      '<g fill="none" stroke="#a34a0a" stroke-width="1.15" stroke-linecap="round" opacity="0.72">' +
      '<path d="M36 108 Q50 102 64 108"/><path d="M34 132 Q50 125 66 132"/><path d="M33 156 Q50 149 67 156"/>' +
      '<path d="M33 180 Q50 173 67 180"/><path d="M35 198 Q50 192 65 198"/></g>' +
      '<path fill="none" stroke="#7a3606" stroke-width="0.9" stroke-linecap="round" opacity="0.35" d="M39 54 Q37 90 38 128 Q39 168 42 206"/>' +
      '<ellipse cx="50" cy="221" rx="17" ry="7" fill="#3d7a24"/><ellipse cx="50" cy="220" rx="15" ry="6" fill="#5cb832"/>' +
      '<g stroke-linejoin="round" stroke-linecap="round">' +
      '<path fill="url(#fpChwLeafShadow)" stroke="#1f4a12" stroke-width="0.35" d="M36 218 L30 222 L24 218 L20 225 L12 222 L10 232 L2 236 L8 244 L0 252 L10 256 L6 266 L16 264 L20 272 L28 266 L32 274 L42 268 L50 220 Z"/>' +
      '<path fill="url(#fpChwLeafShadow)" stroke="#1f4a12" stroke-width="0.35" d="M64 218 L70 222 L76 218 L80 225 L88 222 L90 232 L98 236 L92 244 L100 252 L90 256 L94 266 L84 264 L80 272 L72 266 L68 274 L58 268 L50 220 Z"/>' +
      '<path fill="url(#fpChwLeafBright)" stroke="#2d6a1a" stroke-width="0.4" d="M50 217 L46 224 L36 222 L40 234 L32 240 L38 250 L32 260 L42 256 L40 268 L50 262 L60 268 L58 256 L68 260 L62 250 L68 240 L60 234 L64 222 L54 224 Z"/>' +
      '</g></svg>';
    root.appendChild(sway);
    return root;
  }

  /** Earthworm dangling from the owl’s beak while scroll-chew is active (SVG top = grip point). */
  function createFloatingOwlWorm() {
    const root = document.createElement('div');
    root.className = 'fp-owl-worm';
    root.setAttribute('aria-hidden', 'true');
    const sway = document.createElement('div');
    sway.className = 'fp-owl-worm-sway';
    sway.innerHTML =
      '<svg class="fp-owl-worm-svg" viewBox="0 0 24 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path fill="none" stroke="#8a3e46" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" d="M12 4.5 C9.5 18 14.5 28 10.8 40 C7.5 52 14 62 11.2 73 C9.5 80 11.2 87.5 11.2 87.5"/>' +
      '<path fill="none" stroke="#c56e76" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round" d="M12 4.5 C9.5 18 14.5 28 10.8 40 C7.5 52 14 62 11.2 73 C9.5 80 11.2 87.5 11.2 87.5"/>' +
      '<path fill="none" stroke="#e8aeb4" stroke-width="2.4" stroke-linecap="round" stroke-opacity="0.75" d="M12.8 7 C11 20 13.5 30 11.5 41 C9 53 12.5 63 10.8 72"/>' +
      '<path fill="none" stroke="#6a3038" stroke-width="0.42" stroke-linecap="round" stroke-opacity="0.55" d="M7 15 Q12 17 17 15 M6.5 29 Q12 31 17.5 29 M7 43 Q12 45 17 43 M6.8 57 Q12 59 17.2 57 M7.2 71 Q12 73 16.8 71"/>' +
      '</svg>';
    root.appendChild(sway);
    return root;
  }

  /** Wide trash pile + bag art, behind the raccoon; visible only while scroll-chew is active. */
  function createRaccoonTrashHeapLayer() {
    const wrap = document.createElement('div');
    wrap.className = 'fp-raccoon-trash-heap';
    wrap.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'fp-raccoon-trash-heap-inner';
    const img = document.createElement('img');
    img.className = 'fp-raccoon-trash-heap-img';
    img.src = chrome.runtime.getURL('icons/raccoon-trash-heap.png');
    img.alt = '';
    img.draggable = false;
    inner.appendChild(img);
    wrap.appendChild(inner);
    return wrap;
  }

  /** Carrot prop is bunny-only. */
  function syncFloatingFabCarrotVisibility() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const existing = stage.querySelector('.fp-chew-carrot');
    if (cachedMascotId === 'bunny') {
      if (!existing) stage.appendChild(createFloatingChewCarrot());
    } else if (existing) {
      existing.remove();
    }
  }

  function syncFloatingFabOwlWormVisibility() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const existing = stage.querySelector('.fp-owl-worm');
    if (cachedMascotId === 'owl') {
      if (!existing) stage.appendChild(createFloatingOwlWorm());
    } else if (existing) {
      existing.remove();
    }
  }

  /** Holly sprig (two-tone leaves + three red berries) in the grass band — not centered on the fox. */
  function createFoxBerriesGrassSides() {
    const wrap = document.createElement('div');
    wrap.className = 'fp-fox-berries-wrap';
    wrap.setAttribute('aria-hidden', 'true');

    const left = document.createElement('div');
    left.className = 'fp-fox-berry-cluster fp-fox-berry-cluster--left';
    const leftInner = document.createElement('div');
    leftInner.className = 'fp-fox-berry-cluster-inner';
    leftInner.innerHTML =
      '<svg class="fp-fox-berry-svg" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="fpHollyGradL" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="28" y2="0">' +
      '<stop offset="0%" stop-color="#8fe088"/>' +
      '<stop offset="100%" stop-color="#2d7a45"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<path fill="url(#fpHollyGradL)" d="M14 17.2L8.5 14.2 7.2 11.2 5 11.8 6 9 3.5 8.5 5.2 6.5 2.8 5.5 5.5 4.8 6.4 2.2 8.8 4.5 10.5 1.8 11.8 4.8 14 2.8 15.2 6 17.2 4 18 7.2 20.5 6.2 19.8 9.5 22.5 10.2 20.2 12.5 17.8 11.5 14 17.2Z"/>' +
      '<path fill="url(#fpHollyGradL)" opacity="0.93" d="M13.5 18.5L7.5 16.5 6 14.2 4.2 14.5 5.2 12 3.2 11.5 4.8 9.8 3.2 8.5 5.8 8.2 6.5 6.2 8.5 7.8 10 5.5 11.5 8.2 13 6.5 14.2 9.2 16 7.8 17 10.5 19 9.8 18.2 12.5 20 13.2 18 15 15.5 14 13.5 18.5Z"/>' +
      '<g fill="none" stroke="#143d24" stroke-width="0.4" stroke-linecap="round">' +
      '<path d="M6.5 3.5Q10 10 13.8 16.5"/>' +
      '<path d="M9 7L7 8.2M11 5L9.5 6.8M13.5 4.5L12.5 7M16 5.5L15 8M18.5 7L17 9.5"/>' +
      '<path d="M6.2 8.5Q9 12.5 13 17"/>' +
      '<path d="M8 11L6.5 12.2M9.5 9L8 10.5M11.5 7.5L10.2 9.5"/>' +
      '</g>' +
      '<circle cx="14" cy="17.15" r="2.95" fill="#b01022"/>' +
      '<ellipse cx="12.85" cy="16.1" rx="0.95" ry="1.1" fill="#e86a7a" opacity="0.58"/>' +
      '<ellipse cx="14" cy="14.9" rx="0.5" ry="0.38" fill="#121212"/>' +
      '<circle cx="10.4" cy="21.15" r="2.82" fill="#b01022"/>' +
      '<ellipse cx="9.35" cy="20.15" rx="0.88" ry="1.02" fill="#e86a7a" opacity="0.52"/>' +
      '<ellipse cx="10.4" cy="19" rx="0.46" ry="0.34" fill="#121212"/>' +
      '<circle cx="17.6" cy="21.15" r="2.82" fill="#b01022"/>' +
      '<ellipse cx="16.55" cy="20.15" rx="0.88" ry="1.02" fill="#e86a7a" opacity="0.52"/>' +
      '<ellipse cx="17.6" cy="19" rx="0.46" ry="0.34" fill="#121212"/>' +
      '</svg>';
    left.appendChild(leftInner);

    const right = document.createElement('div');
    right.className = 'fp-fox-berry-cluster fp-fox-berry-cluster--right';
    const rightInner = document.createElement('div');
    rightInner.className = 'fp-fox-berry-cluster-inner';
    rightInner.innerHTML =
      '<svg class="fp-fox-berry-svg" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="fpHollyGradR" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="28" y2="0">' +
      '<stop offset="0%" stop-color="#8fe088"/>' +
      '<stop offset="100%" stop-color="#2d7a45"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<g transform="matrix(-1,0,0,1,28,0)">' +
      '<path fill="url(#fpHollyGradR)" d="M14 17.2L8.5 14.2 7.2 11.2 5 11.8 6 9 3.5 8.5 5.2 6.5 2.8 5.5 5.5 4.8 6.4 2.2 8.8 4.5 10.5 1.8 11.8 4.8 14 2.8 15.2 6 17.2 4 18 7.2 20.5 6.2 19.8 9.5 22.5 10.2 20.2 12.5 17.8 11.5 14 17.2Z"/>' +
      '<path fill="url(#fpHollyGradR)" opacity="0.93" d="M13.5 18.5L7.5 16.5 6 14.2 4.2 14.5 5.2 12 3.2 11.5 4.8 9.8 3.2 8.5 5.8 8.2 6.5 6.2 8.5 7.8 10 5.5 11.5 8.2 13 6.5 14.2 9.2 16 7.8 17 10.5 19 9.8 18.2 12.5 20 13.2 18 15 15.5 14 13.5 18.5Z"/>' +
      '<g fill="none" stroke="#143d24" stroke-width="0.4" stroke-linecap="round">' +
      '<path d="M6.5 3.5Q10 10 13.8 16.5"/>' +
      '<path d="M9 7L7 8.2M11 5L9.5 6.8M13.5 4.5L12.5 7M16 5.5L15 8M18.5 7L17 9.5"/>' +
      '<path d="M6.2 8.5Q9 12.5 13 17"/>' +
      '<path d="M8 11L6.5 12.2M9.5 9L8 10.5M11.5 7.5L10.2 9.5"/>' +
      '</g>' +
      '</g>' +
      '<circle cx="14" cy="17.15" r="2.95" fill="#b01022"/>' +
      '<ellipse cx="15.15" cy="16.1" rx="0.95" ry="1.1" fill="#e86a7a" opacity="0.58"/>' +
      '<ellipse cx="14" cy="14.9" rx="0.5" ry="0.38" fill="#121212"/>' +
      '<circle cx="17.6" cy="21.15" r="2.82" fill="#b01022"/>' +
      '<ellipse cx="18.65" cy="20.15" rx="0.88" ry="1.02" fill="#e86a7a" opacity="0.52"/>' +
      '<ellipse cx="17.6" cy="19" rx="0.46" ry="0.34" fill="#121212"/>' +
      '<circle cx="10.4" cy="21.15" r="2.82" fill="#b01022"/>' +
      '<ellipse cx="9.35" cy="20.15" rx="0.88" ry="1.02" fill="#e86a7a" opacity="0.52"/>' +
      '<ellipse cx="10.4" cy="19" rx="0.46" ry="0.34" fill="#121212"/>' +
      '</svg>';
    right.appendChild(rightInner);

    wrap.appendChild(left);
    wrap.appendChild(right);
    return wrap;
  }

  function syncFloatingFabFoxBerryClusterVisibility() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    const grass = host?.querySelector('.fp-floating-grass-wrap');
    if (!grass || !host) return;
    host.querySelectorAll('.fp-chew-stage > .fp-fox-berry-cluster').forEach((el) => el.remove());
    const existing = host.querySelector('.fp-fox-berries-wrap');
    if (cachedMascotId === 'fox') {
      if (!existing) grass.appendChild(createFoxBerriesGrassSides());
    } else if (existing) {
      existing.remove();
    }
  }

  /** Strip legacy raccoon paper-wad layers (no longer used). */
  function syncFloatingFabRaccoonTrashWrap() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    host.querySelectorAll('.fp-raccoon-trash-wrap').forEach((el) => el.remove());
  }

  /** Trash heap image behind raccoon (raccoon only). */
  function syncFloatingFabRaccoonTrashHeapVisibility() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const icon = stage.querySelector('.footprints-floating-bunny-img');
    const existing = stage.querySelector('.fp-raccoon-trash-heap');
    if (cachedMascotId === 'raccoon') {
      if (!existing && icon) {
        stage.insertBefore(createRaccoonTrashHeapLayer(), icon);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  function stopRaccoonLauncherEatingMatteLoop() {
    if (fpRaccoonEatingMatteRaf) {
      cancelAnimationFrame(fpRaccoonEatingMatteRaf);
      fpRaccoonEatingMatteRaf = 0;
    }
    const src = document.querySelector('#footprints-floating-bunny .fp-raccoon-eating-src');
    if (src && src._fpEatVfcId != null && typeof src.cancelVideoFrameCallback === 'function') {
      try {
        src.cancelVideoFrameCallback(src._fpEatVfcId);
      } catch (e) {
        /* ignore */
      }
      src._fpEatVfcId = null;
    }
  }

  function applyRaccoonLauncherMatteLumaKey(imageData, threshold, feather) {
    const d = imageData.data;
    const f = Math.max(0, feather);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      if (L >= threshold) {
        d[i + 3] = 0;
      } else if (f > 0 && L >= threshold - f) {
        const a = ((threshold - L) / f) * 255;
        d[i + 3] = Math.min(d[i + 3], Math.max(0, Math.round(a)));
      }
    }
  }

  /**
   * Average RGB along frame perimeter (character is usually centered; mat fills edges).
   * @returns {{ r: number, g: number, b: number } | null}
   */
  function estimateRaccoonLauncherMatteBgFromPerimeter(imageData, cw, ch) {
    const d = imageData.data;
    const t = Math.max(2, Math.min(16, Math.floor(Math.min(cw, ch) * 0.06)));
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    function addPixel(x, y) {
      const i = (Math.min(ch - 1, y) * cw + Math.min(cw - 1, x)) * 4;
      sr += d[i];
      sg += d[i + 1];
      sb += d[i + 2];
      n++;
    }
    let y;
    let x;
    for (y = 0; y < t; y++) for (x = 0; x < cw; x++) addPixel(x, y);
    for (y = ch - t; y < ch; y++) for (x = 0; x < cw; x++) addPixel(x, y);
    for (y = t; y < ch - t; y++) for (x = 0; x < t; x++) addPixel(x, y);
    for (y = t; y < ch - t; y++) for (x = cw - t; x < cw; x++) addPixel(x, y);
    if (!n) return null;
    return { r: sr / n, g: sg / n, b: sb / n };
  }

  /**
   * Hidden decoder &lt;video&gt; sits beneath a keyed &lt;canvas&gt;; transparent pixels would otherwise
   * composite the raw video — including the native controls strip. Keep frames decodable but never painted.
   * @param {HTMLVideoElement} v
   */
  function configureFootprintsDecoderVideo(v) {
    if (!v || v.tagName !== 'VIDEO') return;
    try {
      v.controls = false;
    } catch (e) {
      /* ignore */
    }
    try {
      v.removeAttribute('controls');
    } catch (e) {
      /* ignore */
    }
    try {
      v.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback nofullscreen');
    } catch (e) {
      /* ignore */
    }
    try {
      v.setAttribute('disablepictureinpicture', '');
    } catch (e) {
      /* ignore */
    }
    try {
      v.disablePictureInPicture = true;
    } catch (e) {
      /* ignore */
    }
    try {
      v.disableRemotePlayback = true;
    } catch (e) {
      /* ignore */
    }
  }

  const FP_MATTE_DECODER_HOST_ID = 'footprints-matte-decoder-host';

  /**
   * Off-screen container for walk matte decoders. If they stay under the keyed &lt;canvas&gt;,
   * transparent pixels can still composite the playing &lt;video&gt; (including native controls UI).
   * @returns {HTMLDivElement}
   */
  function ensureFootprintsMatteDecoderHost() {
    let host = document.getElementById(FP_MATTE_DECODER_HOST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = FP_MATTE_DECODER_HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed!important;left:-20000px!important;top:0!important;width:800px!important;height:800px!important;' +
      'opacity:0!important;pointer-events:none!important;overflow:hidden!important;margin:0!important;padding:0!important;' +
      'border:none!important;z-index:-2147483648!important;contain:strict!important;';
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  /**
   * @param {HTMLDivElement} walkWrap `.footprints-*-retrace-walk-stack`
   * @param {HTMLVideoElement} videoEl
   */
  function mountFootprintsWalkMatteDecoder(walkWrap, videoEl) {
    if (!walkWrap || !videoEl) return;
    if (!walkWrap._fpMatteDecoderVideos) walkWrap._fpMatteDecoderVideos = [];
    walkWrap._fpMatteDecoderVideos.push(videoEl);
    videoEl.style.cssText =
      'position:absolute!important;left:0!important;top:0!important;width:800px!important;height:800px!important;' +
      'max-width:none!important;max-height:none!important;opacity:0!important;pointer-events:none!important;' +
      'margin:0!important;padding:0!important;border:none!important;visibility:hidden!important;';
    ensureFootprintsMatteDecoderHost().appendChild(videoEl);
  }

  function disposeFootprintsWalkMatteDecoders(walkWrap) {
    if (!walkWrap || !walkWrap._fpMatteDecoderVideos || !walkWrap._fpMatteDecoderVideos.length) return;
    walkWrap._fpMatteDecoderVideos.forEach((v) => {
      try {
        v.pause();
      } catch (e) {
        /* ignore */
      }
      try {
        v.remove();
      } catch (e2) {
        /* ignore */
      }
    });
    walkWrap._fpMatteDecoderVideos = null;
  }

  function fpWalkMatteVideos(walkWrap, selector) {
    if (walkWrap && walkWrap._fpMatteDecoderVideos && walkWrap._fpMatteDecoderVideos.length) {
      return walkWrap._fpMatteDecoderVideos;
    }
    return walkWrap ? Array.from(walkWrap.querySelectorAll(selector)) : [];
  }

  function fpFirstWalkMatteVideo(walkWrap, selector) {
    if (walkWrap && walkWrap._fpMatteDecoderVideos && walkWrap._fpMatteDecoderVideos.length) {
      return walkWrap._fpMatteDecoderVideos[0];
    }
    return walkWrap ? walkWrap.querySelector(selector) : null;
  }

  function fpRaccoonWalkLayerDecoderVideo(layer) {
    if (layer && layer._fpRaccoonWalkMatteVid) return layer._fpRaccoonWalkMatteVid;
    return layer ? layer.querySelector('video.fp-raccoon-walk-matte-src') : null;
  }

  function fpBunnyWalkLayerDecoderVideo(layer) {
    if (layer && layer._fpBunnyWalkMatteVid) return layer._fpBunnyWalkMatteVid;
    return layer ? layer.querySelector('video.fp-bunny-walk-matte-src') : null;
  }

  function fpFoxWalkLayerDecoderVideo(layer) {
    if (layer && layer._fpFoxWalkMatteVid) return layer._fpFoxWalkMatteVid;
    return layer ? layer.querySelector('video.fp-fox-walk-matte-src') : null;
  }

  function applyRaccoonLauncherMatteColorDistanceKey(imageData, br, bg, bb, dist, feather) {
    const d = imageData.data;
    const f = Math.max(0, feather);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const dr = r - br;
      const dg = g - bg;
      const db = b - bb;
      const distPix = Math.sqrt(dr * dr + dg * dg + db * db);
      if (distPix <= dist) {
        d[i + 3] = 0;
      } else if (f > 0 && distPix < dist + f) {
        const u = (distPix - dist) / f;
        d[i + 3] = Math.min(d[i + 3], Math.max(0, Math.round(u * 255)));
      }
    }
  }

  /**
   * Walk clips often keep an orange mat strip above the raccoon (not matched by perimeter gray).
   * Top ~14%: aggressive key for a thin vivid bar; up to ~40%: slightly stricter thresholds so the
   * band above the head clears without eating neutral fur.
   */
  function applyRaccoonRetraceWalkMatteOrangeBar(imageData, cw, ch) {
    const d = imageData.data;
    const yTopAgg = Math.max(1, Math.floor(ch * 0.14));
    const yEnd = Math.max(yTopAgg + 1, Math.floor(ch * 0.4));
    const feather = 28;
    for (let y = 0; y < yEnd; y++) {
      const aggressive = y < yTopAgg;
      const hard = aggressive ? 72 : 94;
      const chromMin = aggressive ? 22 : 38;
      const rMin = aggressive ? 132 : 150;
      const bMax = aggressive ? 178 : 165;
      const gMin = aggressive ? 28 : 38;
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const chrom = r - 0.5 * (g + b);
        if (chrom < chromMin) continue;
        if (r < rMin) continue;
        if (b > bMax) continue;
        if (g < gMin) continue;
        const s = chrom + (r - b) * 0.14;
        if (s >= hard) {
          d[i + 3] = 0;
        } else if (s > hard - feather) {
          const t = (s - (hard - feather)) / feather;
          d[i + 3] = Math.min(d[i + 3], Math.max(0, Math.round((1 - t) * 255)));
        }
      }
    }
  }

  function drawRaccoonLauncherEatingMatteFrame(srcVideo, canvas) {
    if (!srcVideo || !canvas) return;
    if (srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = srcVideo.videoWidth;
    const vh = srcVideo.videoHeight;
    if (vw < 2 || vh < 2) return;
    const maxS = FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE;
    const scale = Math.min(1, maxS / Math.max(vw, vh));
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      srcVideo._fpEatMatteBg = null;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(srcVideo, 0, 0, cw, ch);
    let id;
    try {
      id = ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return;
    }
    if (!srcVideo._fpEatMatteBg) {
      srcVideo._fpEatMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    }
    if (srcVideo._fpEatMatteBg) {
      const m = srcVideo._fpEatMatteBg;
      applyRaccoonLauncherMatteColorDistanceKey(
        id,
        m.r,
        m.g,
        m.b,
        FP_RACCOON_LAUNCHER_MATTE_COLOR_DIST,
        FP_RACCOON_LAUNCHER_MATTE_COLOR_FEATHER,
      );
    } else {
      applyRaccoonLauncherMatteLumaKey(
        id,
        FP_RACCOON_LAUNCHER_MATTE_LUMA_THRESHOLD,
        FP_RACCOON_LAUNCHER_MATTE_LUMA_FEATHER,
      );
    }
    ctx.putImageData(id, 0, 0);
  }

  /** Retrace walk: same perimeter color-distance / luma matte as launcher eating (`_fpWalkMatteBg` per decoder). */
  function drawRaccoonRetraceWalkMatteFrame(srcVideo, canvas) {
    if (!srcVideo || !canvas) return;
    if (srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = srcVideo.videoWidth;
    const vh = srcVideo.videoHeight;
    if (vw < 2 || vh < 2) return;
    const maxS = FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE;
    const scale = Math.min(1, maxS / Math.max(vw, vh));
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      srcVideo._fpWalkMatteBg = null;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(srcVideo, 0, 0, cw, ch);
    let id;
    try {
      id = ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return;
    }
    if (!srcVideo._fpWalkMatteBg) {
      srcVideo._fpWalkMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    }
    if (srcVideo._fpWalkMatteBg) {
      const m = srcVideo._fpWalkMatteBg;
      applyRaccoonLauncherMatteColorDistanceKey(
        id,
        m.r,
        m.g,
        m.b,
        FP_RACCOON_LAUNCHER_MATTE_COLOR_DIST,
        FP_RACCOON_LAUNCHER_MATTE_COLOR_FEATHER,
      );
    } else {
      applyRaccoonLauncherMatteLumaKey(
        id,
        FP_RACCOON_LAUNCHER_MATTE_LUMA_THRESHOLD,
        FP_RACCOON_LAUNCHER_MATTE_LUMA_FEATHER,
      );
    }
    applyRaccoonRetraceWalkMatteOrangeBar(id, cw, ch);
    ctx.putImageData(id, 0, 0);
  }

  /** Bunny retrace walk matte: perimeter color-distance / luma key only (no raccoon orange-bar pass). */
  function drawBunnyRetraceWalkMatteFrame(srcVideo, canvas) {
    if (!srcVideo || !canvas) return;
    if (srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = srcVideo.videoWidth;
    const vh = srcVideo.videoHeight;
    if (vw < 2 || vh < 2) return;
    const maxS = FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE;
    const scale = Math.min(1, maxS / Math.max(vw, vh));
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      srcVideo._fpBunnyWalkMatteBg = null;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(srcVideo, 0, 0, cw, ch);
    let id;
    try {
      id = ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return;
    }
    const walkPath = srcVideo.getAttribute('data-bunny-walk-path') || '';
    const isOwlSource = walkPath.indexOf('owl-') !== -1;
    /*
     * Owl flight clips: border mat color drifts across the timeline (lighting / grade / motion).
     * A single cached perimeter sample mis-keys the middle and end of the clip — refresh every frame.
     */
    if (isOwlSource) {
      srcVideo._fpBunnyWalkMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    } else if (!srcVideo._fpBunnyWalkMatteBg) {
      srcVideo._fpBunnyWalkMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    }
    if (srcVideo._fpBunnyWalkMatteBg) {
      const m = srcVideo._fpBunnyWalkMatteBg;
      applyRaccoonLauncherMatteColorDistanceKey(
        id,
        m.r,
        m.g,
        m.b,
        isOwlSource ? FP_OWL_MATTE_COLOR_DIST : FP_RACCOON_LAUNCHER_MATTE_COLOR_DIST,
        isOwlSource ? FP_OWL_MATTE_COLOR_FEATHER : FP_RACCOON_LAUNCHER_MATTE_COLOR_FEATHER,
      );
    } else {
      applyRaccoonLauncherMatteLumaKey(
        id,
        isOwlSource ? FP_OWL_MATTE_LUMA_THRESHOLD : FP_RACCOON_LAUNCHER_MATTE_LUMA_THRESHOLD,
        isOwlSource ? FP_OWL_MATTE_LUMA_FEATHER : FP_RACCOON_LAUNCHER_MATTE_LUMA_FEATHER,
      );
    }
    if (isOwlSource) {
      applyOwlFlatBackdropKey(id, srcVideo._fpBunnyWalkMatteBg || null);
      applyOwlMatteNeighborHaloCleanup(id);
      if (walkPath.indexOf('owl-flying') !== -1) {
        applyOwlFlyingMatteBottomBarCleanup(id);
      }
    } else applyBunnyBackdropKey(id);
    ctx.putImageData(id, 0, 0);
  }

  function stopRaccoonRetraceWalkMatteLoop(wrap) {
    if (!wrap) return;
    if (wrap._fpWalkMatteRaf) {
      window.cancelAnimationFrame(wrap._fpWalkMatteRaf);
      wrap._fpWalkMatteRaf = 0;
    }
    fpWalkMatteVideos(wrap, 'video.fp-raccoon-walk-matte-src').forEach((v) => {
      v._fpWalkMatteBg = null;
    });
  }

  function startRaccoonRetraceWalkMatteLoop(wrap) {
    stopRaccoonRetraceWalkMatteLoop(wrap);
    if (!wrap || !wrap.isConnected) return;
    function tick() {
      if (!wrap.isConnected) {
        wrap._fpWalkMatteRaf = 0;
        return;
      }
      wrap.querySelectorAll(':scope > .fp-raccoon-walk-ping-layer').forEach((layer) => {
        const v = fpRaccoonWalkLayerDecoderVideo(layer);
        const c = layer.querySelector('canvas.fp-raccoon-walk-matte-canvas');
        if (v && c) drawRaccoonRetraceWalkMatteFrame(v, c);
      });
      wrap._fpWalkMatteRaf = window.requestAnimationFrame(tick);
    }
    wrap._fpWalkMatteRaf = window.requestAnimationFrame(tick);
  }

  function stopBunnyRetraceWalkMatteLoop(wrap) {
    if (!wrap) return;
    if (wrap._fpBunnyWalkMatteRaf) {
      window.cancelAnimationFrame(wrap._fpBunnyWalkMatteRaf);
      wrap._fpBunnyWalkMatteRaf = 0;
    }
    fpWalkMatteVideos(wrap, 'video.fp-bunny-walk-matte-src').forEach((v) => {
      v._fpBunnyWalkMatteBg = null;
    });
  }

  function startBunnyRetraceWalkMatteLoop(wrap) {
    stopBunnyRetraceWalkMatteLoop(wrap);
    if (!wrap || !wrap.isConnected) return;
    function tick() {
      if (!wrap.isConnected) {
        wrap._fpBunnyWalkMatteRaf = 0;
        return;
      }
      const layers = wrap.querySelectorAll(':scope > .fp-bunny-walk-ping-layer');
      if (layers.length) {
        layers.forEach((layer) => {
          const v = fpBunnyWalkLayerDecoderVideo(layer);
          const c = layer.querySelector('canvas.fp-bunny-walk-matte-canvas');
          if (v && c) drawBunnyRetraceWalkMatteFrame(v, c);
        });
      } else {
        const v = fpFirstWalkMatteVideo(wrap, 'video.fp-bunny-walk-matte-src');
        const c = wrap.querySelector('canvas.fp-bunny-walk-matte-canvas');
        if (v && c) drawBunnyRetraceWalkMatteFrame(v, c);
      }
      wrap._fpBunnyWalkMatteRaf = window.requestAnimationFrame(tick);
    }
    wrap._fpBunnyWalkMatteRaf = window.requestAnimationFrame(tick);
  }

  /** Fox retrace walk matte: gentler keying to preserve facial/fur detail. */
  function drawFoxRetraceWalkMatteFrame(srcVideo, canvas) {
    if (!srcVideo || !canvas) return;
    if (srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = srcVideo.videoWidth;
    const vh = srcVideo.videoHeight;
    if (vw < 2 || vh < 2) return;
    const maxS = FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE;
    const scale = Math.min(1, maxS / Math.max(vw, vh));
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      srcVideo._fpFoxWalkMatteBg = null;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(srcVideo, 0, 0, cw, ch);
    let id;
    try {
      id = ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return;
    }
    const srcData = new Uint8ClampedArray(id.data);
    if (!srcVideo._fpFoxWalkMatteBg) {
      srcVideo._fpFoxWalkMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    }
    if (srcVideo._fpFoxWalkMatteBg) {
      const m = srcVideo._fpFoxWalkMatteBg;
      applyRaccoonLauncherMatteColorDistanceKey(
        id,
        m.r,
        m.g,
        m.b,
        FP_FOX_MATTE_COLOR_DIST,
        FP_FOX_MATTE_COLOR_FEATHER,
      );
    } else {
      applyRaccoonLauncherMatteLumaKey(
        id,
        FP_FOX_MATTE_LUMA_THRESHOLD,
        FP_FOX_MATTE_LUMA_FEATHER,
      );
    }
    restoreFoxWhiteFurHighlights(id, srcData, srcVideo._fpFoxWalkMatteBg || null);
    restoreFoxStraightWalkFaceCore(
      id,
      srcData,
      cw,
      ch,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    restoreFoxStraightWalkSubjectCore(
      id,
      srcData,
      cw,
      ch,
      srcVideo._fpFoxWalkMatteBg || null,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    liftFoxStraightWalkMuzzleDarkStreak(
      id,
      cw,
      ch,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    unpremultiplyFoxFrameColors(id);
    enforceFoxStraightWalkMuzzleFromSource(
      id,
      srcData,
      cw,
      ch,
      srcVideo._fpFoxWalkMatteBg || null,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    stripFoxStraightWalkHeadHalo(
      id,
      cw,
      ch,
      srcVideo._fpFoxWalkMatteBg || null,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    repairFoxStraightWalkDarkFaceDelta(
      id,
      srcData,
      cw,
      ch,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    stripFoxWalkGroundPatch(
      id,
      cw,
      ch,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    stripFoxDownWalkDetachedFragments(
      id,
      cw,
      ch,
      srcVideo.getAttribute('data-fox-walk-path') || '',
    );
    ctx.putImageData(id, 0, 0);
  }

  function stopFoxRetraceWalkMatteLoop(wrap) {
    if (!wrap) return;
    if (wrap._fpFoxWalkMatteRaf) {
      window.cancelAnimationFrame(wrap._fpFoxWalkMatteRaf);
      wrap._fpFoxWalkMatteRaf = 0;
    }
    fpWalkMatteVideos(wrap, 'video.fp-fox-walk-matte-src').forEach((v) => {
      v._fpFoxWalkMatteBg = null;
    });
  }

  function startFoxRetraceWalkMatteLoop(wrap) {
    stopFoxRetraceWalkMatteLoop(wrap);
    if (!wrap || !wrap.isConnected) return;
    function tick() {
      if (!wrap.isConnected) {
        wrap._fpFoxWalkMatteRaf = 0;
        return;
      }
      const layers = wrap.querySelectorAll(':scope > .fp-fox-walk-ping-layer');
      if (layers.length) {
        layers.forEach((layer) => {
          const v = fpFoxWalkLayerDecoderVideo(layer);
          const c = layer.querySelector('canvas.fp-fox-walk-matte-canvas');
          if (v && c) drawFoxRetraceWalkMatteFrame(v, c);
        });
      } else {
        const v = fpFirstWalkMatteVideo(wrap, 'video.fp-fox-walk-matte-src');
        const c = wrap.querySelector('canvas.fp-fox-walk-matte-canvas');
        if (v && c) drawFoxRetraceWalkMatteFrame(v, c);
      }
      wrap._fpFoxWalkMatteRaf = window.requestAnimationFrame(tick);
    }
    wrap._fpFoxWalkMatteRaf = window.requestAnimationFrame(tick);
  }

  function startRaccoonLauncherEatingMatteLoop(srcVideo, canvas) {
    stopRaccoonLauncherEatingMatteLoop();
    if (!srcVideo || !canvas) return;
    function tick() {
      const host = document.getElementById(FLOATING_BUNNY_ID);
      if (!host || !host.classList.contains('fp-chew-active')) {
        fpRaccoonEatingMatteRaf = 0;
        return;
      }
      if (!document.contains(srcVideo) || !document.contains(canvas)) {
        fpRaccoonEatingMatteRaf = 0;
        return;
      }
      drawRaccoonLauncherEatingMatteFrame(srcVideo, canvas);
      fpRaccoonEatingMatteRaf = window.requestAnimationFrame(tick);
    }
    if (typeof srcVideo.requestVideoFrameCallback === 'function') {
      const step = () => {
        const host = document.getElementById(FLOATING_BUNNY_ID);
        if (!host || !host.classList.contains('fp-chew-active')) {
          srcVideo._fpEatVfcId = null;
          return;
        }
        if (!document.contains(srcVideo) || !document.contains(canvas)) {
          srcVideo._fpEatVfcId = null;
          return;
        }
        drawRaccoonLauncherEatingMatteFrame(srcVideo, canvas);
        srcVideo._fpEatVfcId = srcVideo.requestVideoFrameCallback(step);
      };
      srcVideo._fpEatVfcId = srcVideo.requestVideoFrameCallback(step);
    } else {
      fpRaccoonEatingMatteRaf = window.requestAnimationFrame(tick);
    }
  }

  /**
   * Raccoon launcher: H.264 eating clip composited onto a canvas (perimeter color + distance matte; see `pulseFloatingBunnyChewWithScroll`).
   * Replaces stage bob + trash heap (CSS). Removed on `error` if the asset is missing or invalid.
   */
  function syncFloatingFabRaccoonLauncherEatingVideoLayer() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const icon = stage.querySelector('.footprints-floating-bunny-img');
    const existingCanvas = stage.querySelector('canvas.fp-raccoon-eating-video');
    const existingSrc = stage.querySelector('video.fp-raccoon-eating-src');
    const hasPartialLayer = (!!existingCanvas) !== (!!existingSrc);
    if (hasPartialLayer) {
      stopRaccoonLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
    }
    if (cachedMascotId !== 'raccoon') {
      stopRaccoonLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
      return;
    }
    if (!icon) return;
    if (existingCanvas && existingSrc) return;
    const src = document.createElement('video');
    src.className = 'fp-raccoon-eating-src';
    src.muted = true;
    src.loop = true;
    src.playsInline = true;
    src.setAttribute('playsinline', '');
    src.setAttribute('aria-hidden', 'true');
    src.preload = 'auto';
    configureFootprintsDecoderVideo(src);
    src.src = chrome.runtime.getURL(FP_RACCOON_LAUNCHER_EATING);
    const cnv = document.createElement('canvas');
    cnv.className = 'fp-raccoon-eating-video';
    cnv.setAttribute('aria-hidden', 'true');
    function tearDown() {
      stopRaccoonLauncherEatingMatteLoop();
      src._fpEatMatteBg = null;
      src.remove();
      cnv.remove();
    }
    src.addEventListener('error', tearDown, { once: true });
    stage.appendChild(src);
    stage.appendChild(cnv);
  }

  function syncRaccoonLauncherScrollChewVideo(active) {
    if (cachedMascotId !== 'raccoon') return;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    const stage = host && host.querySelector('.fp-chew-stage');
    const src = stage && stage.querySelector('video.fp-raccoon-eating-src');
    const cnv = stage && stage.querySelector('canvas.fp-raccoon-eating-video');
    const icon = stage && stage.querySelector('.footprints-floating-bunny-img');
    if (!src || !cnv || !icon) return;
    if (active) {
      cnv.style.setProperty('display', 'block', 'important');
      icon.style.setProperty('opacity', '0', 'important');
      const p = src.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      startRaccoonLauncherEatingMatteLoop(src, cnv);
    } else {
      stopRaccoonLauncherEatingMatteLoop();
      src.pause();
      cnv.style.setProperty('display', 'none', 'important');
      icon.style.removeProperty('opacity');
    }
  }

  function stopBunnyLauncherEatingMatteLoop() {
    if (fpBunnyEatingMatteRaf) {
      cancelAnimationFrame(fpBunnyEatingMatteRaf);
      fpBunnyEatingMatteRaf = 0;
    }
    const src = document.querySelector('#footprints-floating-bunny .fp-bunny-eating-src');
    if (src && src._fpBunnyEatVfcId != null && typeof src.cancelVideoFrameCallback === 'function') {
      try {
        src.cancelVideoFrameCallback(src._fpBunnyEatVfcId);
      } catch (e) {
        /* ignore */
      }
      src._fpBunnyEatVfcId = null;
    }
  }

  function drawBunnyLauncherEatingMatteFrame(srcVideo, canvas) {
    if (!srcVideo || !canvas) return;
    if (srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = srcVideo.videoWidth;
    const vh = srcVideo.videoHeight;
    if (vw < 2 || vh < 2) return;
    const maxS = FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE;
    const scale = Math.min(1, maxS / Math.max(vw, vh));
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      srcVideo._fpBunnyEatMatteBg = null;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(srcVideo, 0, 0, cw, ch);
    let id;
    try {
      id = ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return;
    }
    const isOwlSource = !!(
      srcVideo.classList && srcVideo.classList.contains('fp-owl-eating-src')
    );
    if (isOwlSource) {
      srcVideo._fpBunnyEatMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    } else if (!srcVideo._fpBunnyEatMatteBg) {
      srcVideo._fpBunnyEatMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    }
    if (srcVideo._fpBunnyEatMatteBg) {
      const m = srcVideo._fpBunnyEatMatteBg;
      applyRaccoonLauncherMatteColorDistanceKey(
        id,
        m.r,
        m.g,
        m.b,
        isOwlSource ? FP_OWL_MATTE_COLOR_DIST : FP_RACCOON_LAUNCHER_MATTE_COLOR_DIST,
        isOwlSource ? FP_OWL_MATTE_COLOR_FEATHER : FP_RACCOON_LAUNCHER_MATTE_COLOR_FEATHER,
      );
    } else {
      applyRaccoonLauncherMatteLumaKey(
        id,
        isOwlSource ? FP_OWL_MATTE_LUMA_THRESHOLD : FP_RACCOON_LAUNCHER_MATTE_LUMA_THRESHOLD,
        isOwlSource ? FP_OWL_MATTE_LUMA_FEATHER : FP_RACCOON_LAUNCHER_MATTE_LUMA_FEATHER,
      );
    }
    if (isOwlSource) {
      applyOwlFlatBackdropKey(id, srcVideo._fpBunnyEatMatteBg || null);
      applyOwlMatteNeighborHaloCleanup(id);
    } else applyBunnyBackdropKey(id);
    ctx.putImageData(id, 0, 0);
  }

  /**
   * Bunny videos have a baked checker + neon side bars in the source. After perimeter matte,
   * run a targeted cleanup pass to strip those background pixels while preserving fur tones.
   * @param {ImageData} imageData
   */
  function applyBunnyBackdropKey(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const a = d[i + 3];
      if (a === 0) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      // Checkerboard dark squares and dark matte spill.
      if (luma <= 82) {
        d[i + 3] = 0;
        continue;
      }

      // Checkerboard lighter squares: near-gray + mid luma.
      if (sat <= 22 && luma <= 150) {
        d[i + 3] = 0;
        continue;
      }

      // Neon cyan/teal side bars.
      if (sat >= 48 && g >= 92 && b >= 112 && r <= 120 && b - r >= 24) {
        d[i + 3] = 0;
        continue;
      }

      // Neon purple/magenta side bars.
      if (sat >= 48 && r >= 92 && b >= 108 && g <= 116) {
        d[i + 3] = 0;
      }
    }
  }

  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {{ h: number, s: number, v: number }} h 0–360, s/v 0–1
   */
  function fpRgbToHsv01(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d > 1e-5) {
      if (max === rn) {
        h = (60 * ((gn - bn) / d) + 360) % 360;
      } else if (max === gn) {
        h = (60 * ((bn - rn) / d + 2) + 360) % 360;
      } else {
        h = (60 * ((rn - gn) / d + 4) + 360) % 360;
      }
    }
    return { h, s: max < 1e-5 ? 0 : d / max, v: max };
  }

  /**
   * Remove semi-opaque green/teal halos touching transparency (decoder + feather band).
   * @param {ImageData} imageData
   */
  function applyOwlMatteNeighborHaloCleanup(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const d = imageData.data;
    if (w < 3 || h < 3) return;
    const stride = w * 4;
    for (let y = 1; y < h - 1; y++) {
      const row = y * stride;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x * 4;
        const a = d[i + 3];
        if (a === 0 || a === 255) continue;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const greenExcess = 2 * g - r - b;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        let nearClear = 0;
        const neigh = [i - 4, i + 4, i - stride, i + stride];
        for (let k = 0; k < 4; k++) {
          if (d[neigh[k] + 3] < 24) nearClear++;
        }
        if (nearClear >= 2 && greenExcess > -20 && a < 248) {
          d[i + 3] = 0;
          continue;
        }
        if (nearClear >= 3 && a < 252 && luma >= 158) {
          d[i + 3] = 0;
        }
      }
    }
  }

  /**
   * Owl flight: thin cyan/blue line at the frame bottom often survives keying (decode / baked UI
   * tint / compositor). Nuke the last few raster lines and nearby blue-dominant pixels.
   * @param {ImageData} imageData
   */
  function applyOwlFlyingMatteBottomBarCleanup(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const d = imageData.data;
    if (w < 2 || h < 4) return;
    const hardRows = Math.min(5, h);
    for (let y = h - hardRows; y < h; y++) {
      let i = (y * w) * 4;
      for (let x = 0; x < w; x++, i += 4) {
        d[i + 3] = 0;
      }
    }
    const softLow = Math.max(0, h - hardRows - 12);
    const softHigh = h - hardRows;
    for (let y = softLow; y < softHigh; y++) {
      let i = (y * w) * 4;
      for (let x = 0; x < w; x++, i += 4) {
        const a = d[i + 3];
        if (a === 0) continue;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        if (b >= r + 16 && b >= g + 10 && b >= 72) {
          d[i + 3] = 0;
        }
      }
    }
    const topRows = Math.min(3, h);
    for (let y = 0; y < topRows; y++) {
      let i = (y * w) * 4;
      for (let x = 0; x < w; x++, i += 4) {
        d[i + 3] = 0;
      }
    }
  }

  /**
   * Owl clips use a flat light/white studio backdrop (not bunny checkerboards). Strip residual
   * backdrop after perimeter key without using the bunny-specific backdrop pass.
   * @param {ImageData} imageData
   * @param {{ r: number, g: number, b: number } | null} matteBg
   */
  function applyOwlFlatBackdropKey(imageData, matteBg) {
    if (!imageData) return;
    const d = imageData.data;
    const matGreen =
      matteBg &&
      matteBg.g > matteBg.r + 5 &&
      matteBg.g > matteBg.b + 5;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];
      let a = d[i + 3];
      if (a === 0) continue;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      /* Chroma-style green axis; works on desaturated / dark greens where max-min is small. */
      const greenExcess = 2 * g - r - b;

      /* Keep warm brown / tan body feathers (do not treat as backdrop). */
      const warmBody = r >= g + 3 && g >= b - 8 && r >= 52 && sat >= 12;
      if (warmBody && luma < 228) {
        /* Mild green spill on opaque feathers: pull G toward neutrals (keeps alpha). */
        if (matGreen && a >= 240 && greenExcess > 6 && greenExcess < 28) {
          const tgt = Math.round((r + b) * 0.5);
          d[i + 1] = Math.min(g, Math.max(tgt, Math.round(g * 0.92 + tgt * 0.08)));
        }
        continue;
      }

      /* Kill almost-transparent bright speckles (matte fringe / decode noise). */
      if (a < 52 && luma >= 172) {
        d[i + 3] = 0;
        continue;
      }

      /*
       * Studio greens: dark forest mat, green screen, or desaturated card-green behind the owl.
       * Require clear green dominance so we do not eat yellow beak / warm highlights.
       */
      const greenDominant = g >= r + 12 && g >= b + 12;
      if (greenDominant && g >= 44) {
        if (luma <= 210 && sat >= 14) {
          d[i + 3] = 0;
          continue;
        }
        if (luma <= 140 && sat >= 8) {
          d[i + 3] = 0;
          continue;
        }
      }
      /* Lighter green-grey mat near subject edge. */
      if (g >= r + 8 && g >= b + 8 && luma >= 95 && luma <= 235 && sat >= 18) {
        d[i + 3] = 0;
        continue;
      }

      /* Low-saturation greens (compressed mat): G leads R/B slightly. */
      if (g >= r + 3 && g >= b + 3 && g >= min + 4 && luma <= 155 && sat <= 38 && greenExcess >= 6) {
        d[i + 3] = 0;
        continue;
      }

      /*
       * HSV green→teal band: catches mat + spill where R,G,B are close (low RGB "saturation")
       * but hue still reads green — common with dark card mats and macroblocks.
       */
      const hsv = fpRgbToHsv01(r, g, b);
      if (
        hsv.s >= 0.042 &&
        hsv.v >= 0.022 &&
        hsv.v <= 0.992 &&
        hsv.h >= 64 &&
        hsv.h <= 205
      ) {
        const owlWarm = r >= g + 10 && sat >= 16 && hsv.h < 78;
        if (!owlWarm) {
          d[i + 3] = 0;
          continue;
        }
      }

      /* Hard white / near-white floor and sky. */
      if (luma >= 248 && sat <= 32) {
        d[i + 3] = 0;
        continue;
      }
      if (luma >= 232 && sat <= 16) {
        d[i + 3] = 0;
        continue;
      }

      if (matteBg) {
        const dr = r - matteBg.r;
        const dg = g - matteBg.g;
        const db = b - matteBg.b;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        /* Flat regions still close to sampled perimeter matte colour. */
        if (dist <= 52 && sat <= 52 && luma >= 168) {
          d[i + 3] = 0;
          continue;
        }
        if (dist <= 36 && sat <= 72 && luma >= 148) {
          d[i + 3] = 0;
          continue;
        }
        /*
         * Half-keyed fringe: still near perimeter sample and greenish — full transparent so it
         * does not composite as a green haze on dark UI.
         */
        if (
          matGreen &&
          a > 0 &&
          a < 255 &&
          dist <= 78 &&
          greenExcess >= 2 &&
          !(r >= g + 8 && sat >= 18)
        ) {
          d[i + 3] = 0;
          continue;
        }
        if (matGreen && a > 0 && a < 255 && dist <= 58 && luma >= 120 && luma <= 215) {
          d[i + 3] = 0;
          continue;
        }
      }
    }
  }

  /**
   * Fox clips contain bright white facial/chest fur that can be mistaken for matte background.
   * Restore alpha on likely fur highlights after keying, while avoiding perimeter bg tones.
   * @param {ImageData} imageData
   * @param {Uint8ClampedArray} srcData
   * @param {{ r: number, g: number, b: number } | null} matteBg
   */
  function restoreFoxWhiteFurHighlights(imageData, srcData, matteBg) {
    if (!imageData || !srcData) return;
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const sr = srcData[i];
      const sg = srcData[i + 1];
      const sb = srcData[i + 2];
      const max = Math.max(sr, sg, sb);
      const min = Math.min(sr, sg, sb);
      const sat = max - min;
      const luma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
      const orangeFur = sr >= sg + 14 && sg >= sb + 4;
      if (orangeFur) continue;
      // Bright neutral/warm-white fur only (slightly broader to catch muzzle gradients).
      if (!(luma >= 136 && sat <= 72 && sg >= 96 && sb >= 76)) continue;
      if (matteBg) {
        const dr = sr - matteBg.r;
        const dg = sg - matteBg.g;
        const db = sb - matteBg.b;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        // If this is essentially perimeter bg, do not restore.
        if (dist <= FP_FOX_MATTE_COLOR_DIST + 8) continue;
      }
      // Restore original fur color, with a tiny lift to counter matte darkening.
      d[i] = Math.min(255, Math.round(sr * 1.06));
      d[i + 1] = Math.min(255, Math.round(sg * 1.06));
      d[i + 2] = Math.min(255, Math.round(sb * 1.06));
      d[i + 3] = 255;
    }
  }

  /**
   * Straight-walk fox clip can lose muzzle detail from matte spill.
   * Re-impose source pixels in a central face ellipse for fur-like tones only.
   * @param {ImageData} imageData
   * @param {Uint8ClampedArray} srcData
   * @param {number} cw
   * @param {number} ch
   * @param {string} walkPath
   */
  function restoreFoxStraightWalkFaceCore(imageData, srcData, cw, ch, walkPath) {
    if (!imageData || !srcData) return;
    if (walkPath !== FP_FOX_WALK_STRAIGHT_M4V) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = ch * 0.355;
    const rx = Math.max(10, cw * 0.185);
    const ry = Math.max(10, ch * 0.165);
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(ch - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny > 1) continue;
        const i = (y * cw + x) * 4;
        const sr = srcData[i];
        const sg = srcData[i + 1];
        const sb = srcData[i + 2];
        const max = Math.max(sr, sg, sb);
        const min = Math.min(sr, sg, sb);
        const sat = max - min;
        const luma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const orangeFur = sr >= sg + 12 && sg >= sb - 8 && sr >= 88;
        // Avoid restoring near-pure white neutral backdrop pixels.
        const tooNeutralBrightBg = luma >= 206 && sat <= 12;
        const whiteFur =
          !tooNeutralBrightBg &&
          luma >= 122 &&
          luma <= 232 &&
          sat >= 8 &&
          sat <= 78 &&
          sg >= 92 &&
          sb >= 70 &&
          sr >= sg - 14;
        if (!orangeFur && !whiteFur) continue;
        // Only patch pixels that appear darkened/erased versus source.
        const or = d[i];
        const og = d[i + 1];
        const ob = d[i + 2];
        const oa = d[i + 3];
        const outLuma = 0.299 * or + 0.587 * og + 0.114 * ob;
        const darkened =
          oa < 246 || outLuma + 16 < luma || or + og + ob + 30 < sr + sg + sb;
        if (!darkened) continue;
        d[i] = sr;
        d[i + 1] = sg;
        d[i + 2] = sb;
        d[i + 3] = Math.max(oa, 248);
      }
    }
  }

  /**
   * Strong recovery for straight-walk fox: restore subject core pixels by comparing source
   * against perimeter-estimated matte bg (avoid reintroducing near-bg halo around the head).
   * @param {ImageData} imageData
   * @param {Uint8ClampedArray} srcData
   * @param {number} cw
   * @param {number} ch
   * @param {{ r: number, g: number, b: number } | null} matteBg
   * @param {string} walkPath
   */
  function restoreFoxStraightWalkSubjectCore(imageData, srcData, cw, ch, matteBg, walkPath) {
    if (!imageData || !srcData || !matteBg) return;
    if (walkPath !== FP_FOX_WALK_STRAIGHT_M4V) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = ch * 0.43;
    const rx = Math.max(12, cw * 0.29);
    const ry = Math.max(12, ch * 0.34);
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(ch - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny > 1) continue;
        const i = (y * cw + x) * 4;
        const sr = srcData[i];
        const sg = srcData[i + 1];
        const sb = srcData[i + 2];
        const dr = sr - matteBg.r;
        const dg = sg - matteBg.g;
        const db = sb - matteBg.b;
        const distBg = Math.sqrt(dr * dr + dg * dg + db * db);
        const max = Math.max(sr, sg, sb);
        const min = Math.min(sr, sg, sb);
        const sat = max - min;
        const luma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const orangeFur = sr >= sg + 10 && sg >= sb - 10 && sr >= 84;
        const whiteFur = luma >= 118 && sat >= 10 && sat <= 98 && sg >= 88 && sb >= 68;
        // Restore only confident subject pixels (not near-bg halo whites).
        if (distBg < 22 && !orangeFur && !whiteFur) continue;
        d[i] = sr;
        d[i + 1] = sg;
        d[i + 2] = sb;
        d[i + 3] = Math.max(d[i + 3], 246);
      }
    }
  }

  /**
   * Final artifact cleanup for fox straight-walk: lift dark neutral streaks in lower muzzle zone.
   * Keeps eyes/nose untouched by restricting to lower-center face band only.
   * @param {ImageData} imageData
   * @param {number} cw
   * @param {number} ch
   * @param {string} walkPath
   */
  function liftFoxStraightWalkMuzzleDarkStreak(imageData, cw, ch, walkPath) {
    if (!imageData) return;
    if (walkPath !== FP_FOX_WALK_STRAIGHT_M4V) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = ch * 0.36;
    const rx = Math.max(10, cw * 0.16);
    const ry = Math.max(10, ch * 0.15);
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(ch - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      // Lower muzzle only; avoid eyes.
      if (ny < 0.05 || ny > 0.9) continue;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny > 1) continue;
        if (Math.abs(nx) > 0.68) continue;
        const i = (y * cw + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const a = d[i + 3];
        if (a === 0) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const darkNeutral = luma < 96 && sat < 44 && r < 128 && g < 128 && b < 128;
        if (!darkNeutral) continue;
        // Lift toward warm-white fur tone.
        d[i] = Math.min(255, Math.round(r * 0.35 + 170));
        d[i + 1] = Math.min(255, Math.round(g * 0.35 + 156));
        d[i + 2] = Math.min(255, Math.round(b * 0.35 + 144));
        d[i + 3] = Math.max(a, 238);
      }
    }
  }

  /**
   * Final straight-walk safeguard: overwrite muzzle/cheek core with source fur pixels.
   * This removes persistent dark streak artifacts while still skipping near-bg colors.
   * @param {ImageData} imageData
   * @param {Uint8ClampedArray} srcData
   * @param {number} cw
   * @param {number} ch
   * @param {{ r: number, g: number, b: number } | null} matteBg
   * @param {string} walkPath
   */
  function enforceFoxStraightWalkMuzzleFromSource(imageData, srcData, cw, ch, matteBg, walkPath) {
    if (!imageData || !srcData) return;
    if (walkPath !== FP_FOX_WALK_STRAIGHT_M4V) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = ch * 0.37;
    const rx = Math.max(10, cw * 0.22);
    const ry = Math.max(10, ch * 0.18);
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(ch - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny > 1) continue;
        const i = (y * cw + x) * 4;
        const sr = srcData[i];
        const sg = srcData[i + 1];
        const sb = srcData[i + 2];
        const max = Math.max(sr, sg, sb);
        const min = Math.min(sr, sg, sb);
        const sat = max - min;
        const luma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const orangeFur = sr >= sg + 9 && sg >= sb - 10 && sr >= 84;
        const whiteFur = luma >= 104 && sat <= 124 && sg >= 74 && sb >= 56;
        /*
         * Some straight-walk frames darken the lower muzzle into a gray/near-neutral streak after keying.
         * Treat more of the muzzle as "fur-like" (still excluding near-bg) so we can re-impose the source.
         */
        const neutralFur =
          luma >= 96 && luma <= 242 && sat <= 156 && sg >= 62 && sb >= 46 && sr >= sg - 22;
        if (!orangeFur && !whiteFur && !neutralFur) continue;
        if (matteBg) {
          const dr = sr - matteBg.r;
          const dg = sg - matteBg.g;
          const db = sb - matteBg.b;
          const distBg = Math.sqrt(dr * dr + dg * dg + db * db);
          if (distBg < 18) continue;
        }
        const or = d[i];
        const og = d[i + 1];
        const ob = d[i + 2];
        const oa = d[i + 3];
        const outLuma = 0.299 * or + 0.587 * og + 0.114 * ob;
        const tooDark = oa < 246 || outLuma + 18 < luma || or + og + ob + 50 < sr + sg + sb;
        if (!tooDark) continue;
        d[i] = sr;
        d[i + 1] = sg;
        d[i + 2] = sb;
        d[i + 3] = Math.max(d[i + 3], 250);
      }
    }
  }

  /**
   * After aggressive straight-walk face restore, clear any bright neutral halo ring behind head.
   * @param {ImageData} imageData
   * @param {number} cw
   * @param {number} ch
   * @param {{ r: number, g: number, b: number } | null} matteBg
   * @param {string} walkPath
   */
  function stripFoxStraightWalkHeadHalo(imageData, cw, ch, matteBg, walkPath) {
    if (!imageData) return;
    if (walkPath !== FP_FOX_WALK_STRAIGHT_M4V) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = ch * 0.32;
    const outerRx = Math.max(10, cw * 0.27);
    const outerRy = Math.max(10, ch * 0.235);
    const innerRx = Math.max(8, cw * 0.17);
    const innerRy = Math.max(8, ch * 0.14);
    const x0 = Math.max(0, Math.floor(cx - outerRx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + outerRx));
    const y0 = Math.max(0, Math.floor(cy - outerRy));
    const y1 = Math.min(ch - 1, Math.ceil(cy + outerRy));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nxO = (x - cx) / outerRx;
        const nyO = (y - cy) / outerRy;
        const rOuter = nxO * nxO + nyO * nyO;
        if (rOuter > 1) continue;
        const nxI = (x - cx) / innerRx;
        const nyI = (y - cy) / innerRy;
        const rInner = nxI * nxI + nyI * nyI;
        if (rInner < 1) continue; // ring only
        const i = (y * cw + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const a = d[i + 3];
        if (a === 0) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const orangeFur = r >= g + 10 && g >= b - 10 && r >= 84;
        const brightNeutral = luma >= 136 && sat <= 52;
        if (brightNeutral && !orangeFur) {
          d[i + 3] = 0;
        }
      }
    }
  }

  /**
   * Last-pass straight-walk repair: if muzzle/cheek fur ended up darker than source,
   * restore those pixels directly from source.
   * @param {ImageData} imageData
   * @param {Uint8ClampedArray} srcData
   * @param {number} cw
   * @param {number} ch
   * @param {string} walkPath
   */
  function repairFoxStraightWalkDarkFaceDelta(imageData, srcData, cw, ch, walkPath) {
    if (!imageData || !srcData) return;
    if (walkPath !== FP_FOX_WALK_STRAIGHT_M4V) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = ch * 0.37;
    const rx = Math.max(9, cw * 0.2);
    const ry = Math.max(9, ch * 0.17);
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(ch - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      if (ny < -0.25 || ny > 1) continue;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny > 1) continue;
        const i = (y * cw + x) * 4;
        const sr = srcData[i];
        const sg = srcData[i + 1];
        const sb = srcData[i + 2];
        const sa = srcData[i + 3];
        if (sa === 0) continue;
        const sMax = Math.max(sr, sg, sb);
        const sMin = Math.min(sr, sg, sb);
        const sSat = sMax - sMin;
        const sLuma = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const furLike =
          (sr >= sg + 8 && sg >= sb - 10 && sr >= 80) ||
          (sLuma >= 108 && sLuma <= 236 && sSat >= 6 && sSat <= 130 && sg >= 72 && sb >= 52);
        if (!furLike) continue;
        const or = d[i];
        const og = d[i + 1];
        const ob = d[i + 2];
        const oa = d[i + 3];
        const oLuma = 0.299 * or + 0.587 * og + 0.114 * ob;
        const becameTooDark = oa < 246 || oLuma + 14 < sLuma || or + og + ob + 42 < sr + sg + sb;
        if (!becameTooDark) continue;
        d[i] = sr;
        d[i + 1] = sg;
        d[i + 2] = sb;
        d[i + 3] = Math.max(oa, 250);
      }
    }
  }

  /**
   * Remove bright ground/shadow patch under fox feet in straight/away walk clips.
   * @param {ImageData} imageData
   * @param {number} cw
   * @param {number} ch
   * @param {string} walkPath
   */
  function stripFoxWalkGroundPatch(imageData, cw, ch, walkPath) {
    if (!imageData) return;
    const isStraight =
      walkPath === FP_FOX_WALK_STRAIGHT_M4V ||
      walkPath === FP_FOX_WALK_LEFT_M4V;
    const isAway = isFoxWalkAwayVideoPath(walkPath);
    const isAwayRight = walkPath === FP_FOX_WALK_AWAY_RIGHT_M4V;
    if (!isStraight && !isAway) return;
    const d = imageData.data;
    const cx = cw * 0.5;
    const cy = isAway ? ch * 0.82 : ch * 0.86;
    const rx = Math.max(10, cw * (isAway ? 0.27 : 0.31));
    const ry = Math.max(8, ch * (isAway ? 0.13 : 0.15));
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(cw - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(ch - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const ny = (y - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny > 1) continue;
        const i = (y * cw + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const a = d[i + 3];
        if (a === 0) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const orangeFur = r >= g + 14 && g >= b - 8 && r >= 90;
        if (orangeFur) continue;
        const veryWhite = luma >= 166 && sat <= 58;
        const nearWhite = luma >= 126 && sat <= 96 && r >= 92 && g >= 92 && b >= 92;
        if (!veryWhite && !(nearWhite && y >= cy)) continue;
        d[i + 3] = 0;
      }
    }
    // "Away" clip has an extra bright floor patch shifted to the fox's right.
    if (isAway) {
      const cx2 = cw * 0.66;
      const cy2 = ch * 0.865;
      const rx2 = Math.max(8, cw * 0.2);
      const ry2 = Math.max(6, ch * 0.11);
      const xx0 = Math.max(0, Math.floor(cx2 - rx2));
      const xx1 = Math.min(cw - 1, Math.ceil(cx2 + rx2));
      const yy0 = Math.max(0, Math.floor(cy2 - ry2));
      const yy1 = Math.min(ch - 1, Math.ceil(cy2 + ry2));
      for (let y = yy0; y <= yy1; y++) {
        const ny = (y - cy2) / ry2;
        for (let x = xx0; x <= xx1; x++) {
          const nx = (x - cx2) / rx2;
          if (nx * nx + ny * ny > 1) continue;
          const i = (y * cw + x) * 4;
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          const a = d[i + 3];
          if (a === 0) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max - min;
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          const brightPatch = luma >= 120 && sat <= 102 && r >= 86 && g >= 86 && b >= 86;
          if (brightPatch) d[i + 3] = 0;
        }
      }
      // Final tiny residue cleanup: lower-right floor specks that can sit outside the green glow.
      for (let y = Math.max(0, Math.floor(ch * 0.8)); y < ch; y++) {
        for (let x = Math.max(0, Math.floor(cw * 0.58)); x < cw; x++) {
          const i = (y * cw + x) * 4;
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          const a = d[i + 3];
          if (a === 0) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max - min;
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          const orangeFur = r >= g + 12 && g >= b - 8 && r >= 86;
          if (orangeFur) continue;
          const floorResidue = luma >= 104 && sat <= 98 && r >= 80 && g >= 80 && b >= 80;
          if (floorResidue) d[i + 3] = 0;
        }
      }
      // Away-right has a brighter underfoot plate that survives generic away cleanup.
      if (isAwayRight) {
        for (let y = Math.max(0, Math.floor(ch * 0.79)); y < ch; y++) {
          for (let x = Math.max(0, Math.floor(cw * 0.5)); x < cw; x++) {
            const i = (y * cw + x) * 4;
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            const a = d[i + 3];
            if (a === 0) continue;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max - min;
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            const orangeFur = r >= g + 11 && g >= b - 9 && r >= 82;
            if (orangeFur) continue;
            const plateResidue = luma >= 98 && sat <= 108 && r >= 78 && g >= 78 && b >= 78;
            if (plateResidue) d[i + 3] = 0;
          }
        }
        // Away-right can also leave a detached white wedge on the lower-left floor.
        for (let y = Math.max(0, Math.floor(ch * 0.8)); y < ch; y++) {
          for (let x = 0; x < Math.min(cw, Math.ceil(cw * 0.38)); x++) {
            const nx = x / Math.max(1, cw - 1);
            const ny = y / Math.max(1, ch - 1);
            if (ny < 0.8 || nx > 0.36) continue;
            const i = (y * cw + x) * 4;
            const r = d[i];
            const g = d[i + 1];
            const b = d[i + 2];
            const a = d[i + 3];
            if (a === 0) continue;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max - min;
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            // Keep bright tail fur core: higher red dominance, mid/high saturation, and closer to body.
            const likelyTailFur = r >= g + 10 && g >= b - 10 && sat >= 36 && nx >= 0.18;
            if (likelyTailFur) continue;
            const leftWedgeResidue = luma >= 110 && sat <= 94 && r >= 88 && g >= 88 && b >= 88;
            if (leftWedgeResidue) d[i + 3] = 0;
          }
        }
      }
    }
    if (isStraight) {
      // Final tiny residue cleanup for straight-walk: faint floor specks under/near feet.
      for (let y = Math.max(0, Math.floor(ch * 0.82)); y < ch; y++) {
        for (let x = Math.max(0, Math.floor(cw * 0.34)); x < Math.min(cw, Math.ceil(cw * 0.72)); x++) {
          const i = (y * cw + x) * 4;
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          const a = d[i + 3];
          if (a === 0) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max - min;
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          const orangeFur = r >= g + 12 && g >= b - 8 && r >= 86;
          if (orangeFur) continue;
          const residue = luma >= 106 && sat <= 100 && r >= 82 && g >= 82 && b >= 82;
          if (residue) d[i + 3] = 0;
        }
      }
      // Extra micro-cleanup outside center-foot corridor (captures leftover edge flecks).
      for (let y = Math.max(0, Math.floor(ch * 0.84)); y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const nx = x / Math.max(1, cw - 1);
          // Preserve a narrow center strip where paws usually render.
          if (nx >= 0.44 && nx <= 0.56) continue;
          const i = (y * cw + x) * 4;
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          const a = d[i + 3];
          if (a === 0) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max - min;
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          const orangeFur = r >= g + 12 && g >= b - 8 && r >= 86;
          if (orangeFur) continue;
          const tinyResidue = luma >= 98 && sat <= 92 && r >= 76 && g >= 76 && b >= 76;
          if (tinyResidue) d[i + 3] = 0;
        }
      }
    }
  }

  /**
   * Left down-walk clip (and mirrored-right usage) only:
   * remove detached matte remnants (e.g. background words) while keeping fox pixels.
   * @param {ImageData} imageData
   * @param {number} cw
   * @param {number} ch
   * @param {string} walkPath
   */
  function stripFoxDownWalkDetachedFragments(imageData, cw, ch, walkPath) {
    if (!imageData) return;
    if (walkPath !== FP_FOX_WALK_LEFT_M4V) return;
    if (cw < 4 || ch < 4) return;
    const d = imageData.data;
    const n = cw * ch;
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    /** @type {Array<{ pixels: Int32Array, count: number }>} */
    const components = [];
    let largestCount = 0;
    const alphaThreshold = 22;
    for (let seed = 0; seed < n; seed++) {
      if (seen[seed]) continue;
      if (d[seed * 4 + 3] < alphaThreshold) continue;
      let head = 0;
      let tail = 0;
      let count = 0;
      const pixels = new Int32Array(n);
      queue[tail++] = seed;
      seen[seed] = 1;
      while (head < tail) {
        const cur = queue[head++];
        pixels[count++] = cur;
        const x = cur % cw;
        const y = (cur / cw) | 0;
        const left = x > 0 ? cur - 1 : -1;
        const right = x + 1 < cw ? cur + 1 : -1;
        const up = y > 0 ? cur - cw : -1;
        const down = y + 1 < ch ? cur + cw : -1;
        if (left >= 0 && !seen[left] && d[left * 4 + 3] >= alphaThreshold) {
          seen[left] = 1;
          queue[tail++] = left;
        }
        if (right >= 0 && !seen[right] && d[right * 4 + 3] >= alphaThreshold) {
          seen[right] = 1;
          queue[tail++] = right;
        }
        if (up >= 0 && !seen[up] && d[up * 4 + 3] >= alphaThreshold) {
          seen[up] = 1;
          queue[tail++] = up;
        }
        if (down >= 0 && !seen[down] && d[down * 4 + 3] >= alphaThreshold) {
          seen[down] = 1;
          queue[tail++] = down;
        }
      }
      if (count > largestCount) largestCount = count;
      components.push({ pixels, count });
    }
    if (largestCount <= 0 || components.length <= 1) return;
    const keepMin = Math.max(56, Math.floor(largestCount * 0.06));
    for (let c = 0; c < components.length; c++) {
      const comp = components[c];
      if (comp.count >= keepMin) continue;
      for (let i = 0; i < comp.count; i++) {
        d[comp.pixels[i] * 4 + 3] = 0;
      }
    }
  }

  /**
   * Some keyed fox pixels keep premultiplied-dark RGB when alpha is reduced.
   * Expand RGB back from alpha to prevent black tinting on light fur.
   * @param {ImageData} imageData
   */
  function unpremultiplyFoxFrameColors(imageData) {
    if (!imageData) return;
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a <= 0 || a >= 255) continue;
      const k = 255 / a;
      d[i] = Math.min(255, Math.round(d[i] * k));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] * k));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] * k));
    }
  }

  function startBunnyLauncherEatingMatteLoop(srcVideo, canvas) {
    stopBunnyLauncherEatingMatteLoop();
    if (!srcVideo || !canvas) return;
    function tick() {
      const host = document.getElementById(FLOATING_BUNNY_ID);
      if (!host || !host.classList.contains('fp-chew-active')) {
        fpBunnyEatingMatteRaf = 0;
        return;
      }
      if (!document.contains(srcVideo) || !document.contains(canvas)) {
        fpBunnyEatingMatteRaf = 0;
        return;
      }
      drawBunnyLauncherEatingMatteFrame(srcVideo, canvas);
      fpBunnyEatingMatteRaf = window.requestAnimationFrame(tick);
    }
    if (typeof srcVideo.requestVideoFrameCallback === 'function') {
      const step = () => {
        const host = document.getElementById(FLOATING_BUNNY_ID);
        if (!host || !host.classList.contains('fp-chew-active')) {
          srcVideo._fpBunnyEatVfcId = null;
          return;
        }
        if (!document.contains(srcVideo) || !document.contains(canvas)) {
          srcVideo._fpBunnyEatVfcId = null;
          return;
        }
        drawBunnyLauncherEatingMatteFrame(srcVideo, canvas);
        srcVideo._fpBunnyEatVfcId = srcVideo.requestVideoFrameCallback(step);
      };
      srcVideo._fpBunnyEatVfcId = srcVideo.requestVideoFrameCallback(step);
    } else {
      fpBunnyEatingMatteRaf = window.requestAnimationFrame(tick);
    }
  }

  function syncFloatingFabBunnyLauncherEatingVideoLayer() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const icon = stage.querySelector('.footprints-floating-bunny-img');
    const existingCanvas = stage.querySelector('canvas.fp-bunny-eating-video');
    const existingSrc = stage.querySelector('video.fp-bunny-eating-src');
    const hasPartialLayer = (!!existingCanvas) !== (!!existingSrc);
    if (hasPartialLayer) {
      stopBunnyLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
    }
    if (cachedMascotId !== 'bunny') {
      stopBunnyLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
      return;
    }
    if (!icon) return;
    if (existingCanvas && existingSrc) return;
    const src = document.createElement('video');
    src.className = 'fp-bunny-eating-src';
    src.muted = true;
    src.loop = true;
    src.playsInline = true;
    src.setAttribute('playsinline', '');
    src.setAttribute('aria-hidden', 'true');
    src.preload = 'auto';
    configureFootprintsDecoderVideo(src);
    src.src = chrome.runtime.getURL(FP_BUNNY_LAUNCHER_EATING);
    const cnv = document.createElement('canvas');
    cnv.className = 'fp-bunny-eating-video';
    cnv.setAttribute('aria-hidden', 'true');
    function tearDown() {
      stopBunnyLauncherEatingMatteLoop();
      src._fpBunnyEatMatteBg = null;
      src.remove();
      cnv.remove();
    }
    src.addEventListener('error', tearDown, { once: true });
    stage.appendChild(src);
    stage.appendChild(cnv);
  }

  function syncBunnyLauncherScrollChewVideo(active) {
    if (cachedMascotId !== 'bunny') return;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    const stage = host && host.querySelector('.fp-chew-stage');
    const src = stage && stage.querySelector('video.fp-bunny-eating-src');
    const cnv = stage && stage.querySelector('canvas.fp-bunny-eating-video');
    const icon = stage && stage.querySelector('.footprints-floating-bunny-img');
    if (!src || !cnv || !icon) return;
    if (active) {
      cnv.style.setProperty('display', 'block', 'important');
      icon.style.setProperty('opacity', '0', 'important');
      const p = src.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      startBunnyLauncherEatingMatteLoop(src, cnv);
    } else {
      stopBunnyLauncherEatingMatteLoop();
      src.pause();
      cnv.style.setProperty('display', 'none', 'important');
      icon.style.removeProperty('opacity');
    }
  }

  function stopFoxLauncherEatingMatteLoop() {
    if (fpFoxEatingMatteRaf) {
      cancelAnimationFrame(fpFoxEatingMatteRaf);
      fpFoxEatingMatteRaf = 0;
    }
    const src = document.querySelector('#footprints-floating-bunny .fp-fox-eating-src');
    if (src && src._fpFoxEatVfcId != null && typeof src.cancelVideoFrameCallback === 'function') {
      try {
        src.cancelVideoFrameCallback(src._fpFoxEatVfcId);
      } catch (e) {
        /* ignore */
      }
      src._fpFoxEatVfcId = null;
    }
  }

  function drawFoxLauncherEatingMatteFrame(srcVideo, canvas) {
    if (!srcVideo || !canvas) return;
    if (srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const vw = srcVideo.videoWidth;
    const vh = srcVideo.videoHeight;
    if (vw < 2 || vh < 2) return;
    const maxS = FP_RACCOON_LAUNCHER_MATTE_MAX_SIDE;
    const scale = Math.min(1, maxS / Math.max(vw, vh));
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      srcVideo._fpFoxEatMatteBg = null;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(srcVideo, 0, 0, cw, ch);
    let id;
    try {
      id = ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return;
    }
    const srcData = new Uint8ClampedArray(id.data);
    if (!srcVideo._fpFoxEatMatteBg) {
      srcVideo._fpFoxEatMatteBg = estimateRaccoonLauncherMatteBgFromPerimeter(id, cw, ch);
    }
    if (srcVideo._fpFoxEatMatteBg) {
      const m = srcVideo._fpFoxEatMatteBg;
      applyRaccoonLauncherMatteColorDistanceKey(
        id,
        m.r,
        m.g,
        m.b,
        FP_FOX_MATTE_COLOR_DIST,
        FP_FOX_MATTE_COLOR_FEATHER,
      );
    } else {
      applyRaccoonLauncherMatteLumaKey(
        id,
        FP_FOX_MATTE_LUMA_THRESHOLD,
        FP_FOX_MATTE_LUMA_FEATHER,
      );
    }
    restoreFoxWhiteFurHighlights(id, srcData, srcVideo._fpFoxEatMatteBg || null);
    unpremultiplyFoxFrameColors(id);
    ctx.putImageData(id, 0, 0);
  }

  function startFoxLauncherEatingMatteLoop(srcVideo, canvas) {
    stopFoxLauncherEatingMatteLoop();
    if (!srcVideo || !canvas) return;
    function tick() {
      const host = document.getElementById(FLOATING_BUNNY_ID);
      if (!host || !host.classList.contains('fp-chew-active')) {
        fpFoxEatingMatteRaf = 0;
        return;
      }
      if (!document.contains(srcVideo) || !document.contains(canvas)) {
        fpFoxEatingMatteRaf = 0;
        return;
      }
      drawFoxLauncherEatingMatteFrame(srcVideo, canvas);
      fpFoxEatingMatteRaf = window.requestAnimationFrame(tick);
    }
    if (typeof srcVideo.requestVideoFrameCallback === 'function') {
      const step = () => {
        const host = document.getElementById(FLOATING_BUNNY_ID);
        if (!host || !host.classList.contains('fp-chew-active')) {
          srcVideo._fpFoxEatVfcId = null;
          return;
        }
        if (!document.contains(srcVideo) || !document.contains(canvas)) {
          srcVideo._fpFoxEatVfcId = null;
          return;
        }
        drawFoxLauncherEatingMatteFrame(srcVideo, canvas);
        srcVideo._fpFoxEatVfcId = srcVideo.requestVideoFrameCallback(step);
      };
      srcVideo._fpFoxEatVfcId = srcVideo.requestVideoFrameCallback(step);
    } else {
      fpFoxEatingMatteRaf = window.requestAnimationFrame(tick);
    }
  }

  function syncFloatingFabFoxLauncherEatingVideoLayer() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const icon = stage.querySelector('.footprints-floating-bunny-img');
    const existingCanvas = stage.querySelector('canvas.fp-fox-eating-video');
    const existingSrc = stage.querySelector('video.fp-fox-eating-src');
    const hasPartialLayer = (!!existingCanvas) !== (!!existingSrc);
    if (hasPartialLayer) {
      stopFoxLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
    }
    if (cachedMascotId !== 'fox') {
      stopFoxLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
      return;
    }
    if (!icon) return;
    if (existingCanvas && existingSrc) return;
    const src = document.createElement('video');
    src.className = 'fp-fox-eating-src';
    src.muted = true;
    src.loop = true;
    src.playsInline = true;
    src.setAttribute('playsinline', '');
    src.setAttribute('aria-hidden', 'true');
    src.preload = 'auto';
    configureFootprintsDecoderVideo(src);
    src.src = chrome.runtime.getURL(FP_FOX_LAUNCHER_EATING);
    const cnv = document.createElement('canvas');
    cnv.className = 'fp-fox-eating-video';
    cnv.setAttribute('aria-hidden', 'true');
    function tearDown() {
      stopFoxLauncherEatingMatteLoop();
      src._fpFoxEatMatteBg = null;
      src.remove();
      cnv.remove();
    }
    src.addEventListener('error', tearDown, { once: true });
    stage.appendChild(src);
    stage.appendChild(cnv);
  }

  function syncFoxLauncherScrollChewVideo(active) {
    if (cachedMascotId !== 'fox') return;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    const stage = host && host.querySelector('.fp-chew-stage');
    const src = stage && stage.querySelector('video.fp-fox-eating-src');
    const cnv = stage && stage.querySelector('canvas.fp-fox-eating-video');
    const icon = stage && stage.querySelector('.footprints-floating-bunny-img');
    if (!src || !cnv || !icon) return;
    if (active) {
      cnv.style.setProperty('display', 'block', 'important');
      icon.style.setProperty('opacity', '0', 'important');
      const p = src.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      startFoxLauncherEatingMatteLoop(src, cnv);
    } else {
      stopFoxLauncherEatingMatteLoop();
      src.pause();
      cnv.style.setProperty('display', 'none', 'important');
      icon.style.removeProperty('opacity');
    }
  }

  function syncFloatingFabOwlLauncherEatingVideoLayer() {
    const stage = document.querySelector('#footprints-floating-bunny .fp-chew-stage');
    if (!stage) return;
    const icon = stage.querySelector('.footprints-floating-bunny-img');
    const existingCanvas = stage.querySelector('canvas.fp-owl-eating-video');
    const existingSrc = stage.querySelector('video.fp-owl-eating-src');
    const hasPartialLayer = (!!existingCanvas) !== (!!existingSrc);
    if (hasPartialLayer) {
      stopBunnyLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
    }
    if (cachedMascotId !== 'owl') {
      stopBunnyLauncherEatingMatteLoop();
      if (existingCanvas) existingCanvas.remove();
      if (existingSrc) existingSrc.remove();
      if (icon) icon.style.removeProperty('opacity');
      return;
    }
    if (!icon) return;
    if (existingCanvas && existingSrc) return;
    const src = document.createElement('video');
    src.className = 'fp-owl-eating-src';
    src.muted = true;
    src.loop = true;
    src.preload = 'auto';
    src.playsInline = true;
    src.setAttribute('playsinline', '');
    src.setAttribute('aria-hidden', 'true');
    configureFootprintsDecoderVideo(src);
    src.src = chrome.runtime.getURL(FP_OWL_LAUNCHER_EATING);
    const cnv = document.createElement('canvas');
    cnv.className = 'fp-owl-eating-video';
    cnv.setAttribute('aria-hidden', 'true');
    function tearDown() {
      stopBunnyLauncherEatingMatteLoop();
      src._fpBunnyEatMatteBg = null;
      src.remove();
      cnv.remove();
    }
    src.addEventListener(
      'error',
      () => {
        tearDown();
      },
      { once: true },
    );
    stage.appendChild(src);
    stage.appendChild(cnv);
  }

  function syncOwlLauncherScrollChewVideo(active) {
    if (cachedMascotId !== 'owl') return;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    const stage = host && host.querySelector('.fp-chew-stage');
    const src = stage && stage.querySelector('video.fp-owl-eating-src');
    const cnv = stage && stage.querySelector('canvas.fp-owl-eating-video');
    const icon = stage && stage.querySelector('.footprints-floating-bunny-img');
    if (!src || !cnv || !icon) return;
    if (active) {
      cnv.style.setProperty('display', 'block', 'important');
      icon.style.setProperty('opacity', '0', 'important');
      const p = src.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      startBunnyLauncherEatingMatteLoop(src, cnv);
    } else {
      stopBunnyLauncherEatingMatteLoop();
      src.pause();
      cnv.style.setProperty('display', 'none', 'important');
      icon.style.removeProperty('opacity');
    }
  }

  /**
   * @returns {{ path: string, mirrorX: boolean }}
   */
  function pickRaccoonRetraceVideoPath(fromDoc, toDoc) {
    ensureRaccoonWalkAwayAvailabilityProbe();
    const dvx = toDoc.x - fromDoc.x;
    const dvy = toDoc.y - fromDoc.y;
    const horiz = Math.abs(dvx);
    const vert = Math.abs(dvy);
    const awayRatio = 0.92;
    if (dvy < 0 && vert >= horiz * awayRatio) {
      if (fpRaccoonWalkAwayAvailable) {
        return { path: FP_RACCOON_WALK_AWAY_M4V, mirrorX: false };
      }
      return { path: FP_RACCOON_WALK_M4V, mirrorX: dvx < 0 };
    }
    if (dvx > 0) return { path: FP_RACCOON_WALK_M4V, mirrorX: false };
    return { path: FP_RACCOON_WALK_M4V, mirrorX: true };
  }

  function ensureRaccoonWalkAwayAvailabilityProbe() {
    if (fpRaccoonWalkAwayProbeStarted) return;
    fpRaccoonWalkAwayProbeStarted = true;
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    probe.playsInline = true;
    probe.setAttribute('playsinline', '');
    probe.addEventListener(
      'loadedmetadata',
      () => {
        fpRaccoonWalkAwayAvailable = true;
      },
      { once: true },
    );
    probe.addEventListener(
      'error',
      () => {
        fpRaccoonWalkAwayAvailable = false;
      },
      { once: true },
    );
    probe.src = chrome.runtime.getURL(FP_RACCOON_WALK_AWAY_M4V);
  }

  function ensureFoxWalkDownLeftAvailabilityProbe() {
    if (fpFoxWalkDownProbeStarted) return;
    fpFoxWalkDownProbeStarted = true;
    const probeL = document.createElement('video');
    probeL.preload = 'metadata';
    probeL.muted = true;
    probeL.playsInline = true;
    probeL.setAttribute('playsinline', '');
    probeL.addEventListener(
      'loadedmetadata',
      () => {
        fpFoxWalkDownLeftAvailable = true;
      },
      { once: true },
    );
    probeL.addEventListener(
      'error',
      () => {
        fpFoxWalkDownLeftAvailable = false;
      },
      { once: true },
    );
    probeL.src = chrome.runtime.getURL(FP_FOX_WALK_LEFT_M4V);
  }

  /**
   * @returns {{ path: string, mirrorX: boolean }}
   */
  function pickBunnyRetraceVideoPath(fromDoc, toDoc) {
    const dvx = toDoc.x - fromDoc.x;
    const dvy = toDoc.y - fromDoc.y;
    const horiz = Math.abs(dvx);
    const vert = Math.abs(dvy);
    const verticalRatio = 0.92;
    if (dvy > 0 && vert >= horiz * verticalRatio) {
      return { path: FP_BUNNY_WALK_STRAIGHT_M4V, mirrorX: false };
    }
    if (dvy < 0 && vert >= horiz * verticalRatio) {
      return { path: FP_BUNNY_WALK_AWAY_M4V, mirrorX: false };
    }
    return { path: FP_BUNNY_WALK_RIGHT_M4V, mirrorX: dvx < 0 };
  }

  /**
   * @returns {{ path: string, mirrorX: boolean }}
   */
  function isFoxWalkAwayVideoPath(walkPath) {
    return (
      walkPath === FP_FOX_WALK_AWAY_LEFT_M4V || walkPath === FP_FOX_WALK_AWAY_RIGHT_M4V
    );
  }

  function pickFoxRetraceVideoPath(fromDoc, toDoc) {
    ensureFoxWalkDownLeftAvailabilityProbe();
    const dvx = toDoc.x - fromDoc.x;
    const dvy = toDoc.y - fromDoc.y;
    /* Target lower on page: use dedicated left clip and mirror for rightward travel. */
    if (dvy > 0) {
      if (fpFoxWalkDownLeftAvailable) {
        return { path: FP_FOX_WALK_LEFT_M4V, mirrorX: dvx > 0 };
      }
      return { path: FP_FOX_WALK_STRAIGHT_M4V, mirrorX: false };
    }
    /* Target higher (up the page): away-left only when travel is leftward (dvx < 0), away-right when rightward. */
    if (dvy < 0) {
      if (dvx < 0) return { path: FP_FOX_WALK_AWAY_LEFT_M4V, mirrorX: false };
      if (dvx > 0) return { path: FP_FOX_WALK_AWAY_RIGHT_M4V, mirrorX: false };
      return { path: FP_FOX_WALK_AWAY_RIGHT_M4V, mirrorX: false };
    }
    return { path: FP_FOX_WALK_STRAIGHT_M4V, mirrorX: dvx < 0 };
  }

  /**
   * Owl retrace clip: left encode for leftward travel; same clip mirrored for rightward travel;
   * away clip when movement is mostly up-page (destination above start).
   * @returns {{ path: string, mirrorX: boolean }}
   */
  function pickOwlRetraceVideoPath(fromDoc, toDoc) {
    const dvx = toDoc.x - fromDoc.x;
    const dvy = toDoc.y - fromDoc.y;
    const absX = Math.abs(dvx);
    const absY = Math.abs(dvy);
    /* Down → up on the page: destination above start (dvy < 0). Prefer away when vertical dominates. */
    if (dvy < 0 && absY >= absX) {
      return { path: FP_OWL_FLY_AWAY_M4V, mirrorX: false };
    }
    if (dvx < 0) return { path: FP_OWL_FLY_LEFT_M4V, mirrorX: false };
    return { path: FP_OWL_FLY_LEFT_M4V, mirrorX: true };
  }

  function isRaccoonRetraceWalkStack(el) {
    return !!(el && el.classList && el.classList.contains('footprints-raccoon-retrace-walk-stack'));
  }

  function isBunnyRetraceWalkStack(el) {
    return !!(el && el.classList && el.classList.contains('footprints-bunny-retrace-walk-stack'));
  }

  function isFoxRetraceWalkStack(el) {
    return !!(el && el.classList && el.classList.contains('footprints-fox-retrace-walk-stack'));
  }

  /** Detach loop driver, stop matte rAF, pause every walk decoder under a stack (or a legacy lone `<video>`). */
  function pauseRaccoonRetraceWalkVideos(root) {
    if (!root) return;
    if (isRaccoonRetraceWalkStack(root)) {
      stopRaccoonRetraceWalkMatteLoop(root);
      detachRaccoonRetraceWalkSoftLoop(root);
      fpWalkMatteVideos(root, 'video.fp-raccoon-walk-matte-src').forEach((v) => {
        detachRaccoonRetraceWalkSoftLoop(v);
        v.pause();
      });
      return;
    }
    if (isBunnyRetraceWalkStack(root)) {
      stopBunnyRetraceWalkMatteLoop(root);
      detachRaccoonRetraceWalkSoftLoop(root);
      fpWalkMatteVideos(root, 'video.fp-bunny-walk-matte-src').forEach((v) => {
        detachRaccoonRetraceWalkSoftLoop(v);
        v.pause();
      });
      return;
    }
    if (isFoxRetraceWalkStack(root)) {
      stopFoxRetraceWalkMatteLoop(root);
      detachRaccoonRetraceWalkSoftLoop(root);
      fpWalkMatteVideos(root, 'video.fp-fox-walk-matte-src').forEach((v) => {
        detachRaccoonRetraceWalkSoftLoop(v);
        v.pause();
      });
      return;
    }
    detachRaccoonRetraceWalkSoftLoop(root);
    if (root.tagName === 'VIDEO') {
      root.pause();
    }
  }

  function detachRaccoonRetraceWalkSoftLoop(vid) {
    if (!vid) return;
    if (typeof vid._fpWalkPingPongCleanup === 'function') {
      try {
        vid._fpWalkPingPongCleanup();
      } catch (e) {
        /* ignore */
      }
      vid._fpWalkPingPongCleanup = null;
      return;
    }
    if (typeof vid._fpWalkRvfCancel === 'function') {
      try {
        vid._fpWalkRvfCancel();
      } catch (e) {
        /* ignore */
      }
      vid._fpWalkRvfCancel = null;
    }
    if (typeof vid._fpWalkRvfKick === 'function') {
      vid.removeEventListener('playing', vid._fpWalkRvfKick);
      vid._fpWalkRvfKick = null;
    }
    if (typeof vid._fpWalkSoftSeek === 'function') {
      vid.removeEventListener('timeupdate', vid._fpWalkSoftSeek);
      vid._fpWalkSoftSeek = null;
    }
    if (typeof vid._fpWalkSoftEnded === 'function') {
      vid.removeEventListener('ended', vid._fpWalkSoftEnded);
      vid._fpWalkSoftEnded = null;
    }
  }

  /**
   * Two stacked ping layers (hidden `<video>` + keyed `<canvas>`): swap layer visibility before EOF.
   * @param {HTMLDivElement} wrap `.footprints-raccoon-retrace-walk-stack`
   * @param {number} glideMs
   */
  function attachRaccoonRetraceWalkPingPong(wrap, glideMs) {
    detachRaccoonRetraceWalkSoftLoop(wrap);
    const layers = wrap.querySelectorAll(':scope > .fp-raccoon-walk-ping-layer');
    if (layers.length !== 2) return;
    const layerA = layers[0];
    const layerB = layers[1];
    const vidA = fpRaccoonWalkLayerDecoderVideo(layerA);
    const vidB = fpRaccoonWalkLayerDecoderVideo(layerB);
    if (!vidA || !vidB) return;
    const head = REPLAY_RACCOON_WALK_SOFT_HEAD_SEC;
    const tail = REPLAY_RACCOON_WALK_SOFT_TAIL_SEC;
    vidA.loop = vidB.loop = false;

    function setWalkLayerVisible(layer, visible) {
      layer.style.setProperty('opacity', visible ? '1' : '0', 'important');
      layer.style.setProperty('visibility', visible ? 'visible' : 'hidden', 'important');
      layer.style.setProperty('z-index', visible ? '2' : '1', 'important');
    }

    function primeIdle(idle, idleRate) {
      idle.playbackRate = idleRate;
      if (Math.abs(idle.currentTime - head) > 0.035) {
        try {
          idle.currentTime = head;
        } catch (e) {
          /* ignore */
        }
      }
    }

    let active = vidA;
    let idle = vidB;
    let activeLayer = layerA;
    let idleLayer = layerB;
    let rvfCancel = null;

    function cancelRvf() {
      if (typeof rvfCancel === 'function') {
        try {
          rvfCancel();
        } catch (e) {
          /* ignore */
        }
        rvfCancel = null;
      }
    }

    function scheduleRvf(retryCt) {
      retryCt = retryCt || 0;
      if (!wrap.isConnected || typeof active.requestVideoFrameCallback !== 'function') {
        return;
      }
      /* After a swap, `play()` may not have unparked this element yet — do not drop the rVFC chain. */
      if (active.paused) {
        if (retryCt < 120) {
          window.requestAnimationFrame(() => scheduleRvf(retryCt + 1));
        }
        return;
      }
      cancelRvf();
      const who = active;
      try {
        const id = who.requestVideoFrameCallback(onFrame);
        rvfCancel = function fpWalkPingCancelRvf() {
          try {
            who.cancelVideoFrameCallback(id);
          } catch (e) {
            /* ignore */
          }
        };
      } catch (e) {
        rvfCancel = null;
      }
    }

    function swapPingWalk() {
      primeIdle(idle, active.playbackRate);
      /* Show the incoming canvas layer before `play()` on the hidden decoder. */
      setWalkLayerVisible(idleLayer, true);
      setWalkLayerVisible(activeLayer, false);
      active.pause();
      try {
        active.currentTime = head;
      } catch (e) {
        /* ignore */
      }
      const prev = active;
      const prevL = activeLayer;
      active = idle;
      activeLayer = idleLayer;
      idle = prev;
      idleLayer = prevL;
      cancelRvf();
      const pr = active.play();
      const resumePingChain = function fpWalkPingResume() {
        if (!wrap.isConnected) return;
        scheduleRvf(0);
        window.requestAnimationFrame(() => {
          if (wrap.isConnected) scheduleRvf(0);
        });
      };
      if (pr && typeof pr.then === 'function') {
        pr.then(resumePingChain, resumePingChain);
      } else {
        resumePingChain();
      }
    }

    function onFrame(now, metadata) {
      if (!wrap.isConnected) return;
      if (active.paused) {
        scheduleRvf(0);
        return;
      }
      const d = active.duration;
      const t =
        metadata &&
        typeof metadata.mediaTime === 'number' &&
        !Number.isNaN(metadata.mediaTime)
          ? metadata.mediaTime
          : active.currentTime;
      const minDur = tail + head + 0.06;
      if (Number.isFinite(d) && d >= minDur && t >= d - tail) {
        swapPingWalk();
        return;
      }
      const who = active;
      try {
        const id = who.requestVideoFrameCallback(onFrame);
        rvfCancel = function fpWalkPingCancelRvf2() {
          try {
            who.cancelVideoFrameCallback(id);
          } catch (e) {
            /* ignore */
          }
        };
      } catch (e) {
        rvfCancel = null;
      }
    }

    function onWalkVideoPlaying() {
      if (!wrap.isConnected) return;
      scheduleRvf(0);
    }

    function onWalkEnded(ev) {
      const v = ev.target;
      if (!wrap.isConnected || !(v instanceof HTMLVideoElement)) return;
      try {
        v.currentTime = head;
      } catch (e) {
        return;
      }
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      if (v === active) scheduleRvf(0);
    }

    let appliedOnce = false;
    function apply() {
      const d = vidA.duration;
      if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
      if (appliedOnce) return;
      appliedOnce = true;
      const wallSec = glideMs / 1000;
      const loopCount = Math.max(
        1,
        Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
      );
      let rate = (loopCount * d) / wallSec;
      rate = Math.min(3.6, Math.max(0.45, rate));
      vidA.playbackRate = rate;
      vidB.playbackRate = rate;
      setWalkLayerVisible(layerA, true);
      setWalkLayerVisible(layerB, false);
      function primeBHead() {
        try {
          vidB.currentTime = head;
        } catch (e) {
          /* ignore */
        }
        vidB.pause();
      }
      if (vidB.readyState >= HTMLMediaElement.HAVE_METADATA) primeBHead();
      else vidB.addEventListener('loadedmetadata', primeBHead, { once: true });
      active = vidA;
      idle = vidB;
      activeLayer = layerA;
      idleLayer = layerB;
      vidA.addEventListener('playing', onWalkVideoPlaying);
      vidB.addEventListener('playing', onWalkVideoPlaying);
      vidA.addEventListener('ended', onWalkEnded);
      vidB.addEventListener('ended', onWalkEnded);
      scheduleRvf(0);
      startRaccoonRetraceWalkMatteLoop(wrap);
    }

    wrap._fpWalkPingPongCleanup = function fpWalkPingPongCleanup() {
      stopRaccoonRetraceWalkMatteLoop(wrap);
      cancelRvf();
      vidA.removeEventListener('playing', onWalkVideoPlaying);
      vidB.removeEventListener('playing', onWalkVideoPlaying);
      vidA.removeEventListener('ended', onWalkEnded);
      vidB.removeEventListener('ended', onWalkEnded);
      wrap._fpWalkPingPongCleanup = null;
    };

    if (vidA.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    vidA.addEventListener('loadedmetadata', apply, { once: true });
    vidA.addEventListener('durationchange', apply, { once: true });
  }

  function attachBunnyRetraceWalkPingPong(wrap, glideMs, opts) {
    detachRaccoonRetraceWalkSoftLoop(wrap);
    opts = opts || {};
    const layers = wrap.querySelectorAll(':scope > .fp-bunny-walk-ping-layer');
    if (layers.length !== 2) return;
    const layerA = layers[0];
    const layerB = layers[1];
    const vidA = fpBunnyWalkLayerDecoderVideo(layerA);
    const vidB = fpBunnyWalkLayerDecoderVideo(layerB);
    if (!vidA || !vidB) return;
    const head =
      Number.isFinite(opts.headSec) && opts.headSec >= 0
        ? opts.headSec
        : REPLAY_RACCOON_WALK_SOFT_HEAD_SEC;
    const tail =
      Number.isFinite(opts.tailSec) && opts.tailSec >= 0
        ? opts.tailSec
        : REPLAY_RACCOON_WALK_SOFT_TAIL_SEC;
    vidA.loop = vidB.loop = false;

    function setWalkLayerVisible(layer, visible) {
      layer.style.setProperty('opacity', visible ? '1' : '0', 'important');
      layer.style.setProperty('visibility', visible ? 'visible' : 'hidden', 'important');
      layer.style.setProperty('z-index', visible ? '2' : '1', 'important');
    }

    function primeIdle(idle, idleRate) {
      idle.playbackRate = idleRate;
      if (Math.abs(idle.currentTime - head) > 0.035) {
        try {
          idle.currentTime = head;
        } catch (e) {
          /* ignore */
        }
      }
    }

    let active = vidA;
    let idle = vidB;
    let activeLayer = layerA;
    let idleLayer = layerB;
    let rvfCancel = null;

    function cancelRvf() {
      if (typeof rvfCancel === 'function') {
        try {
          rvfCancel();
        } catch (e) {
          /* ignore */
        }
        rvfCancel = null;
      }
    }

    function scheduleRvf(retryCt) {
      retryCt = retryCt || 0;
      if (!wrap.isConnected || typeof active.requestVideoFrameCallback !== 'function') return;
      if (active.paused) {
        if (retryCt < 120) {
          window.requestAnimationFrame(() => scheduleRvf(retryCt + 1));
        }
        return;
      }
      cancelRvf();
      const who = active;
      try {
        const id = who.requestVideoFrameCallback(onFrame);
        rvfCancel = function fpBunnyWalkPingCancelRvf() {
          try {
            who.cancelVideoFrameCallback(id);
          } catch (e) {
            /* ignore */
          }
        };
      } catch (e) {
        rvfCancel = null;
      }
    }

    function swapPingWalk() {
      primeIdle(idle, active.playbackRate);
      setWalkLayerVisible(idleLayer, true);
      setWalkLayerVisible(activeLayer, false);
      active.pause();
      try {
        active.currentTime = head;
      } catch (e) {
        /* ignore */
      }
      const prev = active;
      const prevL = activeLayer;
      active = idle;
      activeLayer = idleLayer;
      idle = prev;
      idleLayer = prevL;
      cancelRvf();
      const pr = active.play();
      const resumePingChain = function fpBunnyWalkPingResume() {
        if (!wrap.isConnected) return;
        scheduleRvf(0);
        window.requestAnimationFrame(() => {
          if (wrap.isConnected) scheduleRvf(0);
        });
      };
      if (pr && typeof pr.then === 'function') {
        pr.then(resumePingChain, resumePingChain);
      } else {
        resumePingChain();
      }
    }

    function onFrame(now, metadata) {
      if (!wrap.isConnected) return;
      if (active.paused) {
        scheduleRvf(0);
        return;
      }
      const d = active.duration;
      const t =
        metadata &&
        typeof metadata.mediaTime === 'number' &&
        !Number.isNaN(metadata.mediaTime)
          ? metadata.mediaTime
          : active.currentTime;
      const minDur = tail + head + 0.06;
      if (Number.isFinite(d) && d >= minDur && t >= d - tail) {
        swapPingWalk();
        return;
      }
      const who = active;
      try {
        const id = who.requestVideoFrameCallback(onFrame);
        rvfCancel = function fpBunnyWalkPingCancelRvf2() {
          try {
            who.cancelVideoFrameCallback(id);
          } catch (e) {
            /* ignore */
          }
        };
      } catch (e) {
        rvfCancel = null;
      }
    }

    function onWalkVideoPlaying() {
      if (!wrap.isConnected) return;
      scheduleRvf(0);
    }

    function onWalkEnded(ev) {
      const v = ev.target;
      if (!wrap.isConnected || !(v instanceof HTMLVideoElement)) return;
      try {
        v.currentTime = head;
      } catch (e) {
        return;
      }
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      if (v === active) scheduleRvf(0);
    }

    let appliedOnce = false;
    function apply() {
      const d = vidA.duration;
      if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
      if (appliedOnce) return;
      appliedOnce = true;
      const wallSec = glideMs / 1000;
      const loopCount = Math.max(
        1,
        Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
      );
      let rate = (loopCount * d) / wallSec;
      rate *= REPLAY_BUNNY_WALK_RATE_SCALE;
      rate = Math.min(3.6, Math.max(0.24, rate));
      vidA.playbackRate = rate;
      vidB.playbackRate = rate;
      setWalkLayerVisible(layerA, true);
      setWalkLayerVisible(layerB, false);
      function primeBHead() {
        try {
          vidB.currentTime = head;
        } catch (e) {
          /* ignore */
        }
        vidB.pause();
      }
      if (vidB.readyState >= HTMLMediaElement.HAVE_METADATA) primeBHead();
      else vidB.addEventListener('loadedmetadata', primeBHead, { once: true });
      active = vidA;
      idle = vidB;
      activeLayer = layerA;
      idleLayer = layerB;
      vidA.addEventListener('playing', onWalkVideoPlaying);
      vidB.addEventListener('playing', onWalkVideoPlaying);
      vidA.addEventListener('ended', onWalkEnded);
      vidB.addEventListener('ended', onWalkEnded);
      scheduleRvf(0);
      startBunnyRetraceWalkMatteLoop(wrap);
    }

    wrap._fpWalkPingPongCleanup = function fpBunnyWalkPingPongCleanup() {
      stopBunnyRetraceWalkMatteLoop(wrap);
      cancelRvf();
      vidA.removeEventListener('playing', onWalkVideoPlaying);
      vidB.removeEventListener('playing', onWalkVideoPlaying);
      vidA.removeEventListener('ended', onWalkEnded);
      vidB.removeEventListener('ended', onWalkEnded);
      wrap._fpWalkPingPongCleanup = null;
    };

    if (vidA.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    vidA.addEventListener('loadedmetadata', apply, { once: true });
    vidA.addEventListener('durationchange', apply, { once: true });
  }

  function attachFoxRetraceWalkPingPong(wrap, glideMs, opts) {
    detachRaccoonRetraceWalkSoftLoop(wrap);
    opts = opts || {};
    const layers = wrap.querySelectorAll(':scope > .fp-fox-walk-ping-layer');
    if (layers.length !== 2) return;
    const layerA = layers[0];
    const layerB = layers[1];
    const vidA = fpFoxWalkLayerDecoderVideo(layerA);
    const vidB = fpFoxWalkLayerDecoderVideo(layerB);
    if (!vidA || !vidB) return;
    const head =
      Number.isFinite(opts.headSec) && opts.headSec >= 0 ? opts.headSec : 0;
    const tail =
      Number.isFinite(opts.tailSec) && opts.tailSec >= 0 ? opts.tailSec : 0.06;
    const fadeMs =
      Number.isFinite(opts.fadeMs) && opts.fadeMs >= 0 ? opts.fadeMs : 120;
    vidA.loop = vidB.loop = false;

    function setWalkLayerVisible(layer, visible) {
      layer.style.setProperty('transition', `opacity ${fadeMs}ms linear`, 'important');
      layer.style.setProperty('opacity', visible ? '1' : '0', 'important');
      layer.style.setProperty('visibility', visible ? 'visible' : 'hidden', 'important');
      layer.style.setProperty('z-index', visible ? '2' : '1', 'important');
    }

    function primeIdle(idle, idleRate) {
      idle.playbackRate = idleRate;
      if (Math.abs(idle.currentTime - head) > 0.035) {
        try {
          idle.currentTime = head;
        } catch (e) {
          /* ignore */
        }
      }
    }

    let active = vidA;
    let idle = vidB;
    let activeLayer = layerA;
    let idleLayer = layerB;
    let rvfCancel = null;

    function cancelRvf() {
      if (typeof rvfCancel === 'function') {
        try {
          rvfCancel();
        } catch (e) {
          /* ignore */
        }
        rvfCancel = null;
      }
    }

    function scheduleRvf(retryCt) {
      retryCt = retryCt || 0;
      if (!wrap.isConnected || typeof active.requestVideoFrameCallback !== 'function') return;
      if (active.paused) {
        if (retryCt < 120) window.requestAnimationFrame(() => scheduleRvf(retryCt + 1));
        return;
      }
      cancelRvf();
      const who = active;
      try {
        const id = who.requestVideoFrameCallback(onFrame);
        rvfCancel = function fpFoxWalkPingCancelRvf() {
          try {
            who.cancelVideoFrameCallback(id);
          } catch (e) {
            /* ignore */
          }
        };
      } catch (e) {
        rvfCancel = null;
      }
    }

    function swapPingWalk() {
      primeIdle(idle, active.playbackRate);
      setWalkLayerVisible(idleLayer, true);
      setWalkLayerVisible(activeLayer, false);
      active.pause();
      try {
        active.currentTime = head;
      } catch (e) {
        /* ignore */
      }
      const prev = active;
      const prevL = activeLayer;
      active = idle;
      activeLayer = idleLayer;
      idle = prev;
      idleLayer = prevL;
      cancelRvf();
      const pr = active.play();
      const resume = () => {
        if (!wrap.isConnected) return;
        scheduleRvf(0);
        window.requestAnimationFrame(() => {
          if (wrap.isConnected) scheduleRvf(0);
        });
      };
      if (pr && typeof pr.then === 'function') pr.then(resume, resume);
      else resume();
    }

    function onFrame(now, metadata) {
      if (!wrap.isConnected) return;
      if (active.paused) {
        scheduleRvf(0);
        return;
      }
      const d = active.duration;
      const t =
        metadata && typeof metadata.mediaTime === 'number' && !Number.isNaN(metadata.mediaTime)
          ? metadata.mediaTime
          : active.currentTime;
      const minDur = tail + head + 0.06;
      if (Number.isFinite(d) && d >= minDur && t >= d - tail) {
        swapPingWalk();
        return;
      }
      scheduleRvf(0);
    }

    function onWalkVideoPlaying() {
      if (!wrap.isConnected) return;
      scheduleRvf(0);
    }

    function onWalkEnded(ev) {
      const v = ev.target;
      if (!wrap.isConnected || !(v instanceof HTMLVideoElement)) return;
      try {
        v.currentTime = head;
      } catch (e) {
        return;
      }
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      if (v === active) scheduleRvf(0);
    }

    let appliedOnce = false;
    function apply() {
      const d = vidA.duration;
      if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
      if (appliedOnce) return;
      appliedOnce = true;
      const wallSec = glideMs / 1000;
      const loopCount = Math.max(1, Math.ceil((wallSec / d) - 1e-9));
      let rate = (loopCount * d) / wallSec;
      rate = Math.min(3.6, Math.max(0.35, rate));
      vidA.playbackRate = rate;
      vidB.playbackRate = rate;
      setWalkLayerVisible(layerA, true);
      setWalkLayerVisible(layerB, false);
      function primeBHead() {
        try {
          vidB.currentTime = head;
        } catch (e) {
          /* ignore */
        }
        vidB.pause();
      }
      if (vidB.readyState >= HTMLMediaElement.HAVE_METADATA) primeBHead();
      else vidB.addEventListener('loadedmetadata', primeBHead, { once: true });
      active = vidA;
      idle = vidB;
      activeLayer = layerA;
      idleLayer = layerB;
      vidA.addEventListener('playing', onWalkVideoPlaying);
      vidB.addEventListener('playing', onWalkVideoPlaying);
      vidA.addEventListener('ended', onWalkEnded);
      vidB.addEventListener('ended', onWalkEnded);
      scheduleRvf(0);
      startFoxRetraceWalkMatteLoop(wrap);
    }

    wrap._fpWalkPingPongCleanup = function fpFoxWalkPingPongCleanup() {
      stopFoxRetraceWalkMatteLoop(wrap);
      cancelRvf();
      vidA.removeEventListener('playing', onWalkVideoPlaying);
      vidB.removeEventListener('playing', onWalkVideoPlaying);
      vidA.removeEventListener('ended', onWalkEnded);
      vidB.removeEventListener('ended', onWalkEnded);
      wrap._fpWalkPingPongCleanup = null;
    };

    if (vidA.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    vidA.addEventListener('loadedmetadata', apply, { once: true });
    vidA.addEventListener('durationchange', apply, { once: true });
  }

  /**
   * Soft loop: rewind before EOF into `REPLAY_RACCOON_WALK_SOFT_HEAD_SEC` instead of native `loop`.
   * Uses `requestVideoFrameCallback` when available (tighter than `timeupdate`) and avoids `fastSeek`
   * (keyframe-only seeks feel like a hard pause). Call `detachRaccoonRetraceWalkSoftLoop` before pause/destroy.
   * @param {HTMLVideoElement} vid
   */
  function attachRaccoonRetraceWalkSoftLoop(vid, opts) {
    if (!vid || vid.tagName !== 'VIDEO') return;
    opts = opts || {};
    detachRaccoonRetraceWalkSoftLoop(vid);
    vid.loop = false;
    const tail =
      Number.isFinite(opts.tailSec) && opts.tailSec >= 0
        ? opts.tailSec
        : REPLAY_RACCOON_WALK_SOFT_TAIL_SEC;
    const head =
      Number.isFinite(opts.headSec) && opts.headSec >= 0
        ? opts.headSec
        : REPLAY_RACCOON_WALK_SOFT_HEAD_SEC;
    const minDur = tail + head + 0.08;

    const onEnded = function fpWalkSoftEnded() {
      /* Do not gate on `paused`: the spec leaves the element paused when `ended` fires. */
      if (!vid.isConnected) return;
      try {
        vid.currentTime = head;
      } catch (e) {
        return;
      }
      const pr = vid.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    };
    vid._fpWalkSoftEnded = onEnded;
    vid.addEventListener('ended', onEnded);

    function scheduleLoopSeek(t, d) {
      if (!Number.isFinite(d) || d < minDur) return;
      if (vid.seeking) return;
      if (t < d - tail) return;
      try {
        vid.currentTime = head;
      } catch (e) {
        return;
      }
      const pr = vid.play();
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    }

    if (typeof vid.requestVideoFrameCallback === 'function') {
      const onFrame = function fpWalkSoftRvfc(now, metadata) {
        if (!vid.isConnected) return;
        if (vid.paused) return;
        const d = vid.duration;
        const t =
          metadata &&
          typeof metadata.mediaTime === 'number' &&
          !Number.isNaN(metadata.mediaTime)
            ? metadata.mediaTime
            : vid.currentTime;
        scheduleLoopSeek(t, d);
        try {
          const id = vid.requestVideoFrameCallback(onFrame);
          vid._fpWalkRvfCancel = function fpWalkRvfCancel() {
            try {
              vid.cancelVideoFrameCallback(id);
            } catch (e) {
              /* ignore */
            }
          };
        } catch (e) {
          vid._fpWalkRvfCancel = null;
        }
      };
      const kick = function fpWalkSoftRvfcKick() {
        if (!vid.isConnected || vid.paused) return;
        if (typeof vid._fpWalkRvfCancel === 'function') {
          try {
            vid._fpWalkRvfCancel();
          } catch (e) {
            /* ignore */
          }
          vid._fpWalkRvfCancel = null;
        }
        try {
          const id = vid.requestVideoFrameCallback(onFrame);
          vid._fpWalkRvfCancel = function fpWalkRvfCancel() {
            try {
              vid.cancelVideoFrameCallback(id);
            } catch (e) {
              /* ignore */
            }
          };
        } catch (e) {
          /* ignore */
        }
      };
      vid._fpWalkRvfKick = kick;
      vid.addEventListener('playing', kick);
      kick();
      return;
    }

    const onTime = function fpWalkSoftSeek() {
      if (vid.paused) return;
      scheduleLoopSeek(vid.currentTime, vid.duration);
    };
    vid._fpWalkSoftSeek = onTime;
    vid.addEventListener('timeupdate', onTime);
  }

  /**
   * Walk clip cycles during the glide; `playbackRate` uses `ceil((glideSec/duration)*REPLAY_RACCOON_WALK_LOOP_DENSITY)`.
   * Raccoon: matte stack with two ping layers (rVFC) or one layer + soft loop (no rVFC).
   * @param {HTMLVideoElement|HTMLDivElement} root
   * @param {number} glideMs
   */
  function syncRaccoonRetraceWalkClipToGlideDuration(root, glideMs) {
    if (!root || glideMs < 250) return;
    if (isRaccoonRetraceWalkStack(root)) {
      const walkPathFromRoot = root.getAttribute('data-raccoon-walk-path') || '';
      const layers = root.querySelectorAll(':scope > .fp-raccoon-walk-ping-layer');
      const firstLayerVid =
        (layers[0] && fpRaccoonWalkLayerDecoderVideo(layers[0])) || null;
      const walkPath =
        walkPathFromRoot ||
        (firstLayerVid && firstLayerVid.getAttribute('data-raccoon-walk-path')) ||
        '';
      const isAway = walkPath === FP_RACCOON_WALK_AWAY_M4V;
      if (isAway) {
        const walkVid = firstLayerVid;
        if (!walkVid || walkVid.tagName !== 'VIDEO') return;
        walkVid.loop = false;
        let appliedOnce = false;
        function applyOne() {
          const d = walkVid.duration;
          if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
          if (appliedOnce) return;
          appliedOnce = true;
          const wallSec = glideMs / 1000;
          const targetSec = wallSec + REPLAY_RACCOON_WALK_AWAY_RATE_PAD_SEC;
          const loopCount = Math.max(
            1,
            Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
          );
          let rate = (loopCount * d) / targetSec;
          rate *= REPLAY_RACCOON_WALK_AWAY_RATE_SCALE;
          rate = Math.min(3.6, Math.max(0.45, rate));
          walkVid.playbackRate = rate;
          attachRaccoonRetraceWalkSoftLoop(walkVid);
          // Keep only one visible layer to avoid seam/ping-pong reset.
          layers.forEach((layer, idx) => {
            layer.style.setProperty('opacity', idx === 0 ? '1' : '0', 'important');
            layer.style.setProperty('visibility', idx === 0 ? 'visible' : 'hidden', 'important');
            layer.style.setProperty('z-index', idx === 0 ? '2' : '1', 'important');
          });
          startRaccoonRetraceWalkMatteLoop(root);
        }
        if (walkVid.readyState >= HTMLMediaElement.HAVE_METADATA) applyOne();
        walkVid.addEventListener('loadedmetadata', applyOne, { once: true });
        walkVid.addEventListener('durationchange', applyOne, { once: true });
        return;
      }
      if (layers.length >= 2) {
        attachRaccoonRetraceWalkPingPong(root, glideMs);
        return;
      }
      if (layers.length === 1) {
        const walkVid = fpRaccoonWalkLayerDecoderVideo(layers[0]);
        if (!walkVid || walkVid.tagName !== 'VIDEO') return;
        walkVid.loop = false;
        let appliedOnce = false;
        function applyOne() {
          const d = walkVid.duration;
          if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
          if (appliedOnce) return;
          appliedOnce = true;
          const wallSec = glideMs / 1000;
          const walkPathSingle =
            walkPathFromRoot || walkVid.getAttribute('data-raccoon-walk-path') || '';
          const isAwaySingle = walkPathSingle === FP_RACCOON_WALK_AWAY_M4V;
          if (isAwaySingle) {
            const targetSec = wallSec + REPLAY_RACCOON_WALK_AWAY_RATE_PAD_SEC;
            const loopCount = Math.max(
              1,
              Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
            );
            let rate = (loopCount * d) / targetSec;
            rate *= REPLAY_RACCOON_WALK_AWAY_RATE_SCALE;
            rate = Math.min(3.6, Math.max(0.45, rate));
            walkVid.playbackRate = rate;
            attachRaccoonRetraceWalkSoftLoop(walkVid);
          } else {
            const loopCount = Math.max(
              1,
              Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
            );
            let rate = (loopCount * d) / wallSec;
            rate = Math.min(3.6, Math.max(0.45, rate));
            walkVid.playbackRate = rate;
            attachRaccoonRetraceWalkSoftLoop(walkVid);
          }
          startRaccoonRetraceWalkMatteLoop(root);
        }
        if (walkVid.readyState >= HTMLMediaElement.HAVE_METADATA) applyOne();
        walkVid.addEventListener('loadedmetadata', applyOne, { once: true });
        walkVid.addEventListener('durationchange', applyOne, { once: true });
        return;
      }
      return;
    }
    if (isBunnyRetraceWalkStack(root)) {
      const bunnyPingLayers = root.querySelectorAll(':scope > .fp-bunny-walk-ping-layer');
      if (bunnyPingLayers.length >= 2) {
        const walkPathPing =
          root.getAttribute('data-bunny-walk-path') ||
          ((bunnyPingLayers[0] && fpBunnyWalkLayerDecoderVideo(bunnyPingLayers[0])) || null)?.getAttribute(
            'data-bunny-walk-path'
          ) ||
          '';
        const isOwlFlightPing =
          walkPathPing === FP_OWL_FLY_LEFT_M4V || walkPathPing === FP_OWL_FLY_AWAY_M4V;
        if (isOwlFlightPing) {
          attachBunnyRetraceWalkPingPong(root, glideMs, {
            headSec: REPLAY_OWL_FLIGHT_SOFT_HEAD_SEC,
            tailSec: REPLAY_OWL_FLIGHT_SOFT_TAIL_SEC,
          });
          return;
        }
      }
      const walkVid = fpFirstWalkMatteVideo(root, 'video.fp-bunny-walk-matte-src');
      if (!walkVid || walkVid.tagName !== 'VIDEO') return;
      walkVid.loop = false;
      let appliedOnce = false;
      function applyOne() {
        const d = walkVid.duration;
        if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
        if (appliedOnce) return;
        appliedOnce = true;
        const wallSec = glideMs / 1000;
        const walkPath =
          root.getAttribute('data-bunny-walk-path') ||
          walkVid.getAttribute('data-bunny-walk-path') ||
          '';
        const isAway = walkPath === FP_BUNNY_WALK_AWAY_M4V;
        const isOwlFlight =
          walkPath === FP_OWL_FLY_LEFT_M4V || walkPath === FP_OWL_FLY_AWAY_M4V;
        if (isAway) {
          // "Away" naturally shrinks through the clip; do one stretched pass to avoid visible size reset at loop seam.
          let rate = d / wallSec;
          rate *= REPLAY_BUNNY_WALK_AWAY_RATE_SCALE;
          rate = Math.min(2.25, Math.max(0.16, rate));
          walkVid.playbackRate = rate;
          detachRaccoonRetraceWalkSoftLoop(walkVid);
        } else {
          const loopCount = Math.max(
            1,
            Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
          );
          let rate = (loopCount * d) / wallSec;
          rate *= REPLAY_BUNNY_WALK_RATE_SCALE;
          rate = Math.min(3.6, Math.max(0.24, rate));
          walkVid.playbackRate = rate;
          attachRaccoonRetraceWalkSoftLoop(
            walkVid,
            isOwlFlight
              ? {
                  headSec: REPLAY_OWL_FLIGHT_SOFT_HEAD_SEC,
                  tailSec: REPLAY_OWL_FLIGHT_SOFT_TAIL_SEC,
                }
              : undefined,
          );
        }
        startBunnyRetraceWalkMatteLoop(root);
      }
      if (walkVid.readyState >= HTMLMediaElement.HAVE_METADATA) applyOne();
      walkVid.addEventListener('loadedmetadata', applyOne, { once: true });
      walkVid.addEventListener('durationchange', applyOne, { once: true });
      return;
    }
    if (isFoxRetraceWalkStack(root)) {
      const foxPingLayers = root.querySelectorAll(':scope > .fp-fox-walk-ping-layer');
      if (foxPingLayers.length >= 2) {
        const walkPathPing =
          root.getAttribute('data-fox-walk-path') ||
          ((foxPingLayers[0] && fpFoxWalkLayerDecoderVideo(foxPingLayers[0])) || null)?.getAttribute(
            'data-fox-walk-path'
          ) ||
          '';
        const isDownPing = walkPathPing === FP_FOX_WALK_LEFT_M4V;
        if (isDownPing) {
          attachFoxRetraceWalkPingPong(root, glideMs, { headSec: 0.05, tailSec: 0.06, fadeMs: 140 });
          return;
        }
      }
      const walkVid = fpFirstWalkMatteVideo(root, 'video.fp-fox-walk-matte-src');
      if (!walkVid || walkVid.tagName !== 'VIDEO') return;
      walkVid.loop = false;
      let appliedOnce = false;
      function applyOne() {
        const d = walkVid.duration;
        if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
        if (appliedOnce) return;
        appliedOnce = true;
        const wallSec = glideMs / 1000;
        const walkPath =
          root.getAttribute('data-fox-walk-path') ||
          walkVid.getAttribute('data-fox-walk-path') ||
          '';
        const isAway = isFoxWalkAwayVideoPath(walkPath);
        const isDown = walkPath === FP_FOX_WALK_LEFT_M4V;
        if (isAway) {
          let rate = d / wallSec;
          rate = Math.min(2.25, Math.max(0.2, rate));
          walkVid.playbackRate = rate;
          detachRaccoonRetraceWalkSoftLoop(walkVid);
        } else {
          const loopCount = Math.max(
            1,
            Math.ceil(((wallSec / d) * (isDown ? 1.0 : REPLAY_RACCOON_WALK_LOOP_DENSITY)) - 1e-9),
          );
          let rate = (loopCount * d) / wallSec;
          rate = Math.min(3.6, Math.max(0.35, rate));
          walkVid.playbackRate = rate;
          attachRaccoonRetraceWalkSoftLoop(
            walkVid,
            isDown
              ? { headSec: REPLAY_FOX_DOWN_SOFT_HEAD_SEC, tailSec: REPLAY_FOX_DOWN_SOFT_TAIL_SEC }
              : undefined,
          );
        }
        startFoxRetraceWalkMatteLoop(root);
      }
      if (walkVid.readyState >= HTMLMediaElement.HAVE_METADATA) applyOne();
      walkVid.addEventListener('loadedmetadata', applyOne, { once: true });
      walkVid.addEventListener('durationchange', applyOne, { once: true });
      return;
    }
    if (root.tagName !== 'VIDEO') return;
    root.loop = false;
    function apply() {
      const d = root.duration;
      if (!Number.isFinite(d) || d < 0.05 || d > 3600) return;
      const wallSec = glideMs / 1000;
      const loopCount = Math.max(
        1,
        Math.ceil(((wallSec / d) * REPLAY_RACCOON_WALK_LOOP_DENSITY) - 1e-9),
      );
      let rate = (loopCount * d) / wallSec;
      rate = Math.min(3.6, Math.max(0.45, rate));
      root.playbackRate = rate;
      attachRaccoonRetraceWalkSoftLoop(root);
    }
    if (root.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    root.addEventListener('loadedmetadata', apply, { once: true });
    root.addEventListener('durationchange', apply, { once: true });
  }

  /**
   * Bunny retrace mascot: hidden video + keyed canvas so walk clips render animal-only (transparent bg).
   * @param {string} relativePath
   * @param {(img: HTMLImageElement) => void} [onVideoFallback]
   * @param {boolean} [mirrorX]
   * @returns {HTMLDivElement}
   */
  function createBunnyRetraceVideoMascot(relativePath, onVideoFallback, mirrorX) {
    mirrorX = !!mirrorX;
    const animal = getFootprintsAnimal('bunny');
    const isOwlFlight = relativePath === FP_OWL_FLY_LEFT_M4V || relativePath === FP_OWL_FLY_AWAY_M4V;
    const owlScale =
      relativePath === FP_OWL_FLY_AWAY_M4V
        ? FP_OWL_RETRACE_AWAY_VIDEO_SCALE
        : FP_OWL_RETRACE_LEFT_VIDEO_SCALE;
    const owlOffsetY =
      relativePath === FP_OWL_FLY_AWAY_M4V
        ? FP_OWL_RETRACE_AWAY_VIDEO_OFFSET_Y_PX
        : FP_OWL_RETRACE_LEFT_VIDEO_OFFSET_Y_PX;
    const owlOffsetX = relativePath === FP_OWL_FLY_AWAY_M4V ? FP_OWL_RETRACE_AWAY_VIDEO_OFFSET_X_PX : 0;
    const wrap = document.createElement('div');
    wrap.className = 'footprints-bunny-retrace-walk-stack';
    wrap.setAttribute('data-bunny-walk-path', relativePath);
    wrap.style.cssText =
      `position:relative!important;width:100%!important;height:100%!important;overflow:${isOwlFlight ? 'visible' : 'hidden'}!important;`;
    function wireWalkMatteSrc(vid, autoplay) {
      vid.className = 'fp-bunny-walk-matte-src';
      vid.muted = true;
      vid.loop = false;
      vid.preload = 'auto';
      vid.autoplay = autoplay !== false;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      configureFootprintsDecoderVideo(vid);
      vid.src = chrome.runtime.getURL(relativePath);
      vid.setAttribute('data-bunny-walk-path', relativePath);
    }
    function applyOwlCanvasPlacement(cnv) {
      if (!isOwlFlight) return;
      cnv.style.setProperty('left', `${owlOffsetX}px`, 'important');
      cnv.style.setProperty('top', `${owlOffsetY}px`, 'important');
      cnv.style.setProperty('transform', `translateZ(0) scale(${owlScale})`, 'important');
      cnv.style.setProperty('transform-origin', 'center bottom', 'important');
    }
    function makeBunnyPingLayer(autoplay, ariaLabel) {
      const layer = document.createElement('div');
      layer.className = 'fp-bunny-walk-ping-layer';
      layer.style.cssText =
        `position:absolute!important;inset:0!important;pointer-events:none!important;overflow:${isOwlFlight ? 'visible' : 'hidden'}!important;`;
      const vid = document.createElement('video');
      wireWalkMatteSrc(vid, autoplay);
      mountFootprintsWalkMatteDecoder(wrap, vid);
      layer._fpBunnyWalkMatteVid = vid;
      const cnv = document.createElement('canvas');
      cnv.className = 'footprints-rabbit-mascot footprints-bunny-retrace-video fp-bunny-walk-matte-canvas';
      cnv.setAttribute('role', 'img');
      if (ariaLabel) {
        cnv.setAttribute('aria-label', ariaLabel);
      } else {
        vid.setAttribute('aria-hidden', 'true');
        cnv.setAttribute('aria-hidden', 'true');
      }
      cnv.style.cssText =
        'position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;' +
        'object-fit:contain!important;object-position:center bottom!important;display:block!important;' +
        'background:transparent!important;pointer-events:none!important;';
      applyOwlCanvasPlacement(cnv);
      layer.appendChild(cnv);
      return { layer, vid };
    }
    if (isOwlFlight && typeof HTMLVideoElement !== 'undefined') {
      const probe = document.createElement('video');
      if (typeof probe.requestVideoFrameCallback === 'function') {
        const primary = makeBunnyPingLayer(true, animal.label + ' guide');
        const secondary = makeBunnyPingLayer(false, '');
        primary.vid.addEventListener(
          'error',
          () => {
            const img = document.createElement('img');
            img.className = 'footprints-rabbit-mascot';
            img.src = cachedMascotUrl;
            img.alt = animal.label + ' guide';
            img.draggable = false;
            img.decoding = 'async';
            disposeFootprintsWalkMatteDecoders(wrap);
            wrap.replaceWith(img);
            if (typeof onVideoFallback === 'function') onVideoFallback(img);
          },
          { once: true },
        );
        wrap.appendChild(primary.layer);
        wrap.appendChild(secondary.layer);
      } else {
        const single = makeBunnyPingLayer(true, animal.label + ' guide');
        single.vid.addEventListener(
          'error',
          () => {
            const img = document.createElement('img');
            img.className = 'footprints-rabbit-mascot';
            img.src = cachedMascotUrl;
            img.alt = animal.label + ' guide';
            img.draggable = false;
            img.decoding = 'async';
            disposeFootprintsWalkMatteDecoders(wrap);
            wrap.replaceWith(img);
            if (typeof onVideoFallback === 'function') onVideoFallback(img);
          },
          { once: true },
        );
        wrap.appendChild(single.layer);
      }
    } else {
      const vid = document.createElement('video');
      wireWalkMatteSrc(vid, true);
      mountFootprintsWalkMatteDecoder(wrap, vid);
      const cnv = document.createElement('canvas');
      cnv.className = 'footprints-rabbit-mascot footprints-bunny-retrace-video fp-bunny-walk-matte-canvas';
      cnv.setAttribute('role', 'img');
      cnv.setAttribute('aria-label', animal.label + ' guide');
      cnv.style.cssText =
        'position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;' +
        'object-fit:contain!important;object-position:center bottom!important;display:block!important;' +
        'background:transparent!important;pointer-events:none!important;';
      applyOwlCanvasPlacement(cnv);
      vid.addEventListener(
        'error',
        () => {
          const img = document.createElement('img');
          img.className = 'footprints-rabbit-mascot';
          img.src = cachedMascotUrl;
          img.alt = animal.label + ' guide';
          img.draggable = false;
          img.decoding = 'async';
          disposeFootprintsWalkMatteDecoders(wrap);
          wrap.replaceWith(img);
          if (typeof onVideoFallback === 'function') onVideoFallback(img);
        },
        { once: true },
      );
      wrap.appendChild(cnv);
    }
    if (mirrorX) {
      wrap.style.setProperty('transform', 'scaleX(-1)', 'important');
      wrap.style.setProperty('transform-origin', 'center bottom', 'important');
    }
    return wrap;
  }

  /**
   * Fox retrace mascot: hidden video + keyed canvas so walk clips render animal-only (transparent bg).
   * @param {string} relativePath
   * @param {(img: HTMLImageElement) => void} [onVideoFallback]
   * @param {boolean} [mirrorX]
   * @returns {HTMLDivElement}
   */
  function createFoxRetraceVideoMascot(relativePath, onVideoFallback, mirrorX) {
    mirrorX = !!mirrorX;
    const animal = getFootprintsAnimal('fox');
    const isDownWalk = relativePath === FP_FOX_WALK_LEFT_M4V;
    const isDownLeft = isDownWalk && !mirrorX;
    const downExtraY = isDownLeft
      ? FP_FOX_RETRACE_DOWN_LEFT_EXTRA_OFFSET_Y_PX
      : isDownWalk && mirrorX
        ? FP_FOX_RETRACE_DOWN_RIGHT_EXTRA_OFFSET_Y_PX
        : 0;
    const downExtraX = isDownLeft ? FP_FOX_RETRACE_DOWN_LEFT_EXTRA_OFFSET_X_PX : 0;
    const foxScale = isDownWalk ? FP_FOX_RETRACE_DOWN_VIDEO_SCALE : FP_FOX_RETRACE_VIDEO_SCALE;
    const wrap = document.createElement('div');
    wrap.className = 'footprints-fox-retrace-walk-stack';
    wrap.setAttribute('data-fox-walk-path', relativePath);
    wrap.style.cssText =
      'position:relative!important;width:100%!important;height:100%!important;overflow:visible!important;';
    function wireWalkMatteSrc(vid, autoplay) {
      vid.className = 'fp-fox-walk-matte-src';
      vid.muted = true;
      vid.loop = false;
      vid.preload = 'auto';
      vid.autoplay = autoplay !== false;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      configureFootprintsDecoderVideo(vid);
      vid.src = chrome.runtime.getURL(relativePath);
      vid.setAttribute('data-fox-walk-path', relativePath);
    }
    function applyFoxCanvasPlacement(cnv) {
      cnv.style.setProperty(
        'left',
        `${(isDownWalk ? FP_FOX_RETRACE_DOWN_VIDEO_OFFSET_X_PX : 0) + downExtraX}px`,
        'important',
      );
      cnv.style.setProperty(
        'top',
        `${(isDownWalk ? FP_FOX_RETRACE_DOWN_VIDEO_OFFSET_Y_PX : 0) + downExtraY + FP_FOX_RETRACE_VIDEO_OFFSET_Y_PX}px`,
        'important',
      );
      cnv.style.setProperty('transform', `translateZ(0) scale(${foxScale})`, 'important');
      cnv.style.setProperty('transform-origin', 'center bottom', 'important');
    }
    function makeFoxPingLayer(autoplay, ariaLabel) {
      const layer = document.createElement('div');
      layer.className = 'fp-fox-walk-ping-layer';
      layer.style.cssText =
        'position:absolute!important;inset:0!important;pointer-events:none!important;overflow:visible!important;';
      const vid = document.createElement('video');
      wireWalkMatteSrc(vid, autoplay);
      mountFootprintsWalkMatteDecoder(wrap, vid);
      layer._fpFoxWalkMatteVid = vid;
      const cnv = document.createElement('canvas');
      cnv.className = 'footprints-rabbit-mascot footprints-fox-retrace-video fp-fox-walk-matte-canvas';
      cnv.setAttribute('role', 'img');
      if (ariaLabel) {
        cnv.setAttribute('aria-label', ariaLabel);
      } else {
        vid.setAttribute('aria-hidden', 'true');
        cnv.setAttribute('aria-hidden', 'true');
      }
      cnv.style.cssText =
        'position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;' +
        'object-fit:contain!important;object-position:center bottom!important;display:block!important;' +
        'background:transparent!important;pointer-events:none!important;';
      applyFoxCanvasPlacement(cnv);
      layer.appendChild(cnv);
      return { layer, vid };
    }

    const wantsSeamlessLoop = relativePath === FP_FOX_WALK_LEFT_M4V;
    if (wantsSeamlessLoop && typeof HTMLVideoElement !== 'undefined') {
      const probe = document.createElement('video');
      if (typeof probe.requestVideoFrameCallback === 'function') {
        const primary = makeFoxPingLayer(true, animal.label + ' guide');
        const secondary = makeFoxPingLayer(false, '');
        primary.vid.addEventListener(
          'error',
          () => {
            const img = document.createElement('img');
            img.className = 'footprints-rabbit-mascot';
            img.src = cachedMascotUrl;
            img.alt = animal.label + ' guide';
            img.draggable = false;
            img.decoding = 'async';
            disposeFootprintsWalkMatteDecoders(wrap);
            wrap.replaceWith(img);
            if (typeof onVideoFallback === 'function') onVideoFallback(img);
          },
          { once: true },
        );
        wrap.appendChild(primary.layer);
        wrap.appendChild(secondary.layer);
      } else {
        const single = makeFoxPingLayer(true, animal.label + ' guide');
        single.vid.addEventListener(
          'error',
          () => {
            const img = document.createElement('img');
            img.className = 'footprints-rabbit-mascot';
            img.src = cachedMascotUrl;
            img.alt = animal.label + ' guide';
            img.draggable = false;
            img.decoding = 'async';
            disposeFootprintsWalkMatteDecoders(wrap);
            wrap.replaceWith(img);
            if (typeof onVideoFallback === 'function') onVideoFallback(img);
          },
          { once: true },
        );
        wrap.appendChild(single.layer);
      }
    } else {
      const vid = document.createElement('video');
      wireWalkMatteSrc(vid, true);
      mountFootprintsWalkMatteDecoder(wrap, vid);
      const cnv = document.createElement('canvas');
      cnv.className = 'footprints-rabbit-mascot footprints-fox-retrace-video fp-fox-walk-matte-canvas';
      cnv.setAttribute('role', 'img');
      cnv.setAttribute('aria-label', animal.label + ' guide');
      cnv.style.cssText =
        'position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;' +
        'object-fit:contain!important;object-position:center bottom!important;display:block!important;' +
        'background:transparent!important;pointer-events:none!important;';
      applyFoxCanvasPlacement(cnv);
      vid.addEventListener(
        'error',
        () => {
          const img = document.createElement('img');
          img.className = 'footprints-rabbit-mascot';
          img.src = cachedMascotUrl;
          img.alt = animal.label + ' guide';
          img.draggable = false;
          img.decoding = 'async';
          disposeFootprintsWalkMatteDecoders(wrap);
          wrap.replaceWith(img);
          if (typeof onVideoFallback === 'function') onVideoFallback(img);
        },
        { once: true },
      );
      wrap.appendChild(cnv);
    }
    if (mirrorX) {
      wrap.style.setProperty('transform', 'scaleX(-1)', 'important');
      wrap.style.setProperty('transform-origin', 'center bottom', 'important');
    }
    return wrap;
  }

  /**
   * @param {string} relativePath
   * @param {(img: HTMLImageElement) => void} [onVideoFallback]
   * @param {boolean} [mirrorX] Horizontal flip (same clip as walk-right, leftward travel).
   */
  function createRaccoonRetraceVideoMascot(relativePath, onVideoFallback, mirrorX) {
    mirrorX = !!mirrorX;
    const animal = getFootprintsAnimal('raccoon');
    const url = chrome.runtime.getURL(relativePath);
    const canvasCss =
      'position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;' +
      'object-fit:contain!important;object-position:center bottom!important;display:block!important;' +
      `background:transparent!important;pointer-events:none!important;` +
      `transform:translateZ(0) scale(${FP_RACCOON_RETRACE_VIDEO_SCALE})!important;` +
      'transform-origin:center bottom!important;';

    function wireWalkMatteSrc(vid, opts) {
      opts = opts || {};
      vid.className = 'fp-raccoon-walk-matte-src';
      vid.muted = true;
      vid.loop = false;
      vid.preload = 'auto';
      vid.autoplay = !!opts.autoplay;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      configureFootprintsDecoderVideo(vid);
      vid.src = url;
      vid.setAttribute('data-raccoon-walk-path', relativePath);
    }

    function makePingLayer(wrap, autoplay, canvasAriaLabel) {
      const layer = document.createElement('div');
      layer.className = 'fp-raccoon-walk-ping-layer';
      layer.style.cssText =
        'position:absolute!important;inset:0!important;pointer-events:none!important;overflow:visible!important;';
      const vid = document.createElement('video');
      wireWalkMatteSrc(vid, { autoplay });
      mountFootprintsWalkMatteDecoder(wrap, vid);
      layer._fpRaccoonWalkMatteVid = vid;
      const cnv = document.createElement('canvas');
      cnv.className = 'footprints-rabbit-mascot footprints-raccoon-retrace-video fp-raccoon-walk-matte-canvas';
      cnv.setAttribute('role', 'img');
      if (canvasAriaLabel) {
        cnv.setAttribute('aria-label', canvasAriaLabel);
      } else {
        vid.setAttribute('aria-hidden', 'true');
        cnv.setAttribute('aria-hidden', 'true');
      }
      cnv.style.cssText = canvasCss;
      layer.appendChild(cnv);
      return layer;
    }

    const probe = document.createElement('video');
    if (typeof probe.requestVideoFrameCallback !== 'function') {
      const wrap = document.createElement('div');
      wrap.className = 'footprints-raccoon-retrace-walk-stack';
      wrap.setAttribute('data-raccoon-walk-path', relativePath);
      wrap.style.cssText =
        'position:relative!important;width:100%!important;height:100%!important;overflow:visible!important;';
      const layer = makePingLayer(wrap, true, animal.label + ' guide');
      wrap.appendChild(layer);
      const vFail = fpRaccoonWalkLayerDecoderVideo(layer);
      if (vFail) {
        vFail.addEventListener(
          'error',
          () => {
            const img = document.createElement('img');
            img.className = 'footprints-rabbit-mascot';
            img.src = cachedMascotUrl;
            img.alt = animal.label + ' guide';
            img.draggable = false;
            img.decoding = 'async';
            disposeFootprintsWalkMatteDecoders(wrap);
            wrap.replaceWith(img);
            if (typeof onVideoFallback === 'function') onVideoFallback(img);
          },
          { once: true },
        );
      }
      if (mirrorX) {
        wrap.style.setProperty('transform', 'scaleX(-1)', 'important');
        wrap.style.setProperty('transform-origin', 'center bottom', 'important');
      }
      return wrap;
    }
    const wrap = document.createElement('div');
    wrap.className = 'footprints-raccoon-retrace-walk-stack';
    wrap.setAttribute('data-raccoon-walk-path', relativePath);
    wrap.style.cssText =
      'position:relative!important;width:100%!important;height:100%!important;overflow:visible!important;';
    const layerA = makePingLayer(wrap, true, animal.label + ' guide');
    const layerB = makePingLayer(wrap, false, null);
    const tearDown = () => {
      const img = document.createElement('img');
      img.className = 'footprints-rabbit-mascot';
      img.src = cachedMascotUrl;
      img.alt = animal.label + ' guide';
      img.draggable = false;
      img.decoding = 'async';
      disposeFootprintsWalkMatteDecoders(wrap);
      wrap.replaceWith(img);
      if (typeof onVideoFallback === 'function') onVideoFallback(img);
    };
    layerA._fpRaccoonWalkMatteVid?.addEventListener('error', tearDown, { once: true });
    layerB._fpRaccoonWalkMatteVid?.addEventListener('error', tearDown, { once: true });
    wrap.appendChild(layerA);
    wrap.appendChild(layerB);
    if (mirrorX) {
      wrap.style.setProperty('transform', 'scaleX(-1)', 'important');
      wrap.style.setProperty('transform-origin', 'center bottom', 'important');
    }
    return wrap;
  }

  function ensureFloatingChewCss() {
    if (document.getElementById(FLOATING_BUNNY_CHEW_CSS_ID)) return;
    document.getElementById('footprints-floating-bunny-anim-style')?.remove();
    document.getElementById('footprints-floating-bunny-anim-style-v2')?.remove();
    const link = document.createElement('link');
    link.id = FLOATING_BUNNY_CHEW_CSS_ID;
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('floating-bunny-chew.css');
    (document.head || document.documentElement).appendChild(link);
  }

  function clearFloatingChewIdleTimer() {
    if (floatingChewIdleTimer) {
      clearTimeout(floatingChewIdleTimer);
      floatingChewIdleTimer = 0;
    }
  }

  /**
   * Return launcher chew/video layers to a known idle state.
   * Needed after replay teardown so post-retrace scroll can restart chew reliably.
   */
  function resetFloatingLauncherChewState() {
    clearFloatingChewIdleTimer();
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    host.classList.remove('fp-chew-active');
    syncRaccoonLauncherScrollChewVideo(false);
    syncBunnyLauncherScrollChewVideo(false);
    syncFoxLauncherScrollChewVideo(false);
    syncOwlLauncherScrollChewVideo(false);
  }

  /** Chew loop runs only while the page is actively scrolling; ends shortly after scroll stops. */
  function pulseFloatingBunnyChewWithScroll() {
    clearStaleReplayStateForLauncherChew();
    if (isReplayUiMounted()) return;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    /*
     * Normal-mode invariant: while not replaying, launcher must never stay in retrace card chrome.
     * Action-recording flows can surface stale host classes/styles without active replay UI.
     */
    if (host.classList.contains(FLOATING_BUNNY_RETRACE_CARD_CLASS)) {
      restoreFloatingBunnyNormalChrome(host);
    }
    /*
     * Safety net: if replay teardown missed UI state, force launcher back to
     * normal mode so scroll-chew can always run post-retrace.
     */
    if (
      host.classList.contains(FLOATING_BUNNY_REPLAY_QUIET_CLASS) ||
      host.querySelector('.' + FLOATING_BUNNY_REPLAY_ARROWS_CLASS) ||
      host.querySelector('.' + FLOATING_BUNNY_REPLAY_STAY_CLASS)
    ) {
      removeFloatingBunnyReplayControls();
      setFloatingFabMascotVisibleInLauncher(true);
    }
    /*
     * Ensure chew video/canvas layers exist before toggling active state.
     * Retrace teardown or video error recovery can leave these layers missing.
     */
    syncFloatingFabRaccoonLauncherEatingVideoLayer();
    syncFloatingFabBunnyLauncherEatingVideoLayer();
    syncFloatingFabFoxLauncherEatingVideoLayer();
    syncFloatingFabOwlLauncherEatingVideoLayer();
    host.classList.add('fp-chew-active');
    syncRaccoonLauncherScrollChewVideo(true);
    syncBunnyLauncherScrollChewVideo(true);
    syncFoxLauncherScrollChewVideo(true);
    syncOwlLauncherScrollChewVideo(true);
    clearFloatingChewIdleTimer();
    floatingChewIdleTimer = setTimeout(() => {
      floatingChewIdleTimer = 0;
      host.classList.remove('fp-chew-active');
      syncRaccoonLauncherScrollChewVideo(false);
      syncBunnyLauncherScrollChewVideo(false);
      syncFoxLauncherScrollChewVideo(false);
      syncOwlLauncherScrollChewVideo(false);
    }, FLOATING_CHEW_SCROLL_IDLE_MS);
  }

  /**
   * Recover launcher scroll-chew when replay state desyncs and leaves stale "replay quiet" flags behind.
   * This keeps normal FAB animations alive after replay teardown races.
   */
  function clearStaleReplayStateForLauncherChew() {
    /*
     * Only skip scroll-driven cleanup while the main replay overlay is up (not dismissed).
     * Do not key off `isReplayUiMounted()` here: the cross-page exit slide sets that true without
     * a live overlay, and a stuck exit slide would otherwise prevent `forceRemoveReplayOverlayUi`
     * from ever running (deadlocking scroll-chew after retrace).
     */
    if (multiPageReplay && hasLiveReplayOverlayDom()) {
      return;
    }
    /*
     * Stale stop callback with no replay UI: clear callback only (never call it from scroll).
     */
    if (typeof stopActiveFootprintsReplay === 'function' && !isReplayUiMounted()) {
      stopActiveFootprintsReplay = null;
    }
    const exitSlideEl = document.getElementById(REPLAY_EXIT_SLIDE_LAYER_ID);
    const inCrossPageExit = !!(multiPageReplay && exitSlideEl);
    if (!hasLiveReplayOverlayDom() && hasReplayDomRemnants() && !inCrossPageExit) {
      forceRemoveReplayOverlayUi();
    }
    /*
     * Session object survived without replay UI — clear background session so UI/state match.
     */
    if (multiPageReplay && !isReplayUiMounted()) {
      const stuck = multiPageReplay;
      const rid = Number.isFinite(stuck.replayRunId) ? stuck.replayRunId : replayRunId;
      abortMultiPageReplay(undefined, rid);
    }
    if (!isReplayUiMounted()) {
      const host = document.getElementById(FLOATING_BUNNY_ID);
      const hasReplayQuietClass =
        !!host && host.classList.contains(FLOATING_BUNNY_REPLAY_QUIET_CLASS);
      const hasReplayControls =
        !!host &&
        (!!host.querySelector('.' + FLOATING_BUNNY_REPLAY_ARROWS_CLASS) ||
          !!host.querySelector('.' + FLOATING_BUNNY_REPLAY_STAY_CLASS));
      if (hasReplayQuietClass || hasReplayControls) {
        removeFloatingBunnyReplayControls();
        setFloatingFabMascotVisibleInLauncher(true);
      }
    }
  }

  /** Any replay layers still in the document (including dismissing overlay). */
  function hasReplayDomRemnants() {
    return (
      !!document.getElementById('footprints-overlay-root') ||
      !!document.getElementById(REPLAY_GUIDE_LAYER_ID) ||
      !!document.getElementById(REPLAY_EXIT_SLIDE_LAYER_ID)
    );
  }

  /** Non-dismissed main replay overlay only (exit slide / guide alone are not "live" here). */
  function hasLiveReplayOverlayDom() {
    const overlay = document.getElementById('footprints-overlay-root');
    return !!(overlay && !overlay.classList.contains('footprints-dismissed'));
  }

  /**
   * True while an interactive replay is on-screen (blocks launcher scroll-chew).
   * When the overlay is fading out (`footprints-dismissed`), treat replay as over for launcher
   * purposes — the guide layer can still exist briefly beside that overlay.
   */
  function isReplayUiMounted() {
    const overlay = document.getElementById('footprints-overlay-root');
    if (overlay && !overlay.classList.contains('footprints-dismissed')) {
      return true;
    }
    if (document.getElementById(REPLAY_EXIT_SLIDE_LAYER_ID)) {
      return true;
    }
    return false;
  }

  function loadFloatingBunnyPos() {
    try {
      let raw = localStorage.getItem(FLOATING_BUNNY_POS_KEY);
      if (!raw) {
        raw = sessionStorage.getItem(FLOATING_BUNNY_POS_KEY);
        if (raw) {
          try {
            localStorage.setItem(FLOATING_BUNNY_POS_KEY, raw);
          } catch (e2) {
            /* quota / private mode */
          }
        }
      }
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || typeof p.left !== 'number' || typeof p.top !== 'number') return null;
      return { left: p.left, top: p.top };
    } catch (e) {
      return null;
    }
  }

  function saveFloatingBunnyPos(left, top) {
    if (multiPageReplay) return;
    const payload = JSON.stringify({ left, top });
    try {
      localStorage.setItem(FLOATING_BUNNY_POS_KEY, payload);
    } catch (e) {
      /* ignore */
    }
    try {
      sessionStorage.setItem(FLOATING_BUNNY_POS_KEY, payload);
    } catch (e2) {
      /* ignore */
    }
  }

  /** Snapshot FAB coordinates before tab sleep / discard so position survives long absence. */
  function persistFloatingBunnyPosFromDom() {
    if (multiPageReplay) return;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    const left = parseFloat(host.style.left);
    const top = parseFloat(host.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      saveFloatingBunnyPos(left, top);
    }
  }

  /** Use visual viewport when available so mobile browser chrome doesn’t push the FAB off-screen. */
  function viewportSizeForFabClamp() {
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      return { w: vv.width, h: vv.height };
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }

  /** Keep a fixed-position box (e.g. FAB host) fully on-screen with `pad` inset. */
  function clampFabToViewport(left, top, width, height) {
    const pad = 8;
    const { w: vw, h: vh } = viewportSizeForFabClamp();
    const boxW = Math.max(1, width);
    const boxH = Math.max(1, height);
    const maxL = Math.max(pad, vw - boxW - pad);
    const maxT = Math.max(pad, vh - boxH - pad);
    return {
      left: Math.min(Math.max(left, pad), maxL),
      top: Math.min(Math.max(top, pad), maxT),
    };
  }

  function clampFloatingBunny(left, top, size) {
    return clampFabToViewport(left, top, size, size);
  }

  function floatingFabHostBoxPx(host) {
    if (!host) {
      return { w: FLOATING_BUNNY_SIZE_PX, h: FLOATING_BUNNY_SIZE_PX };
    }
    const w = host.offsetWidth || FLOATING_BUNNY_SIZE_PX;
    const h = host.offsetHeight || FLOATING_BUNNY_SIZE_PX;
    return { w: Math.max(w, 1), h: Math.max(h, 1) };
  }

  /** Snap #footprints-floating-bunny so its full bounding box stays inside the viewport. */
  function nudgeFloatingFabIntoViewport() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    const { w, h } = floatingFabHostBoxPx(host);
    const left = parseFloat(host.style.left);
    const top = parseFloat(host.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const n = clampFabToViewport(left, top, w, h);
    host.style.setProperty('left', `${n.left}px`, 'important');
    host.style.setProperty('top', `${n.top}px`, 'important');
    if (!multiPageReplay) saveFloatingBunnyPos(n.left, n.top);
  }

  function scheduleNudgeFloatingFabIntoViewport() {
    requestAnimationFrame(() => {
      requestAnimationFrame(nudgeFloatingFabIntoViewport);
    });
  }

  let floatingFabGlobalViewportListenersBound = false;
  function ensureFloatingFabGlobalViewportListeners() {
    if (floatingFabGlobalViewportListenersBound) return;
    floatingFabGlobalViewportListenersBound = true;
    window.addEventListener('resize', nudgeFloatingFabIntoViewport, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', nudgeFloatingFabIntoViewport, { passive: true });
    }
  }

  /** While retrace runs, keep the FAB at the snapshot from replay start (same pixel spot across page navigations). */
  function getFloatingBunnyStartPosition(size) {
    const { w: vw } = viewportSizeForFabClamp();
    const def = clampFabToViewport(vw - size - 18, 18, size, size);
    const m = multiPageReplay;
    if (
      m &&
      m.preReplayFabPos &&
      Number.isFinite(m.preReplayFabPos.left) &&
      Number.isFinite(m.preReplayFabPos.top)
    ) {
      return clampFloatingBunny(m.preReplayFabPos.left, m.preReplayFabPos.top, size);
    }
    const saved = loadFloatingBunnyPos();
    if (saved) return clampFloatingBunny(saved.left, saved.top, size);
    return def;
  }

  /** FAB screen position before replay started (DOM or last saved drag position). */
  function capturePreReplayFabPosition() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (host) {
      const left = parseFloat(host.style.left);
      const top = parseFloat(host.style.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        return { left, top };
      }
    }
    const saved = loadFloatingBunnyPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return { left: saved.left, top: saved.top };
    }
    return null;
  }

  function startCompactReplay() {
    if (
      isFootprintsReplayRunning() ||
      multiPageReplay ||
      document.getElementById('footprints-overlay-root')
    ) {
      invokeStopActiveFootprintsReplay();
      return;
    }
    getActionsFromBg((actions) => {
      startReplayFromActions(actions, { compact: true });
    });
  }

  function removeFloatingLauncherDom() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (host) {
      clearFloatingChewIdleTimer();
      stopRaccoonLauncherEatingMatteLoop();
      host.remove();
    }
  }

  const FLOATING_BUNNY_REPLAY_ARROWS_CLASS = 'footprints-fab-replay-arrows';
  const FLOATING_BUNNY_REPLAY_STAY_CLASS = 'footprints-fab-replay-stay-wrap';
  const FLOATING_BUNNY_RETRACE_CARD_CLASS = 'footprints-fab-retrace-card';
  /** On FAB during multi-step retrace: no scroll-chew, carrot/worm jiggle, or replay-arrow pulse. */
  const FLOATING_BUNNY_REPLAY_QUIET_CLASS = 'footprints-fab-replay-quiet';

  /** White pill around mascot + replay controls; green border and outer glow (matches retrace card mockup). */
  function applyRetraceFabCardChrome(host) {
    if (!host) return;
    const btn = host.querySelector('button');
    host.classList.add(FLOATING_BUNNY_RETRACE_CARD_CLASS);
    host.style.setProperty('display', 'flex', 'important');
    host.style.setProperty('flex-direction', 'column', 'important');
    host.style.setProperty('align-items', 'center', 'important');
    host.style.setProperty('justify-content', 'flex-start', 'important');
    host.style.setProperty('gap', '10px', 'important');
    host.style.setProperty('padding', '12px 18px 16px', 'important');
    host.style.setProperty('background', '#ffffff', 'important');
    host.style.setProperty('border', '2px solid rgba(50, 160, 88, 0.82)', 'important');
    host.style.setProperty('border-radius', '36px', 'important');
    host.style.setProperty(
      'box-shadow',
      '0 0 0 1px rgba(255,255,255,0.98) inset, 0 0 10px 3px rgba(50, 160, 88, 0.32), 0 0 22px 7px rgba(50, 160, 88, 0.18), 0 8px 26px rgba(15, 23, 42, 0.12)',
      'important'
    );
    host.style.setProperty('overflow', 'visible', 'important');
    if (btn) {
      btn.style.setProperty('flex-shrink', '0', 'important');
      btn.style.setProperty('box-shadow', FLOATING_BUNNY_BTN_SHADOW_RETRACE_CARD, 'important');
    }
  }

  function makeFabReplayArrowSvg(direction) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 22 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(ns, 'path');
    if (direction === 'left') {
      path.setAttribute('d', 'M16 6H6m0 0l3-2.75M6 6l3 2.75');
    } else {
      path.setAttribute('d', 'M6 6h10m0 0l-3-2.75M16 6l-3 2.75');
    }
    svg.appendChild(path);
    return svg;
  }

  function makeFabReplayArrowKeyHint(text) {
    const hint = document.createElement('span');
    hint.className = 'footprints-fab-replay-arrow-keyhint';
    hint.textContent = text;
    return hint;
  }

  function updateFloatingBunnyReplayArrowState() {
    const m = multiPageReplay;
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!m || !host || !m.actions || !m.actions.length) return;
    const prevBtn = host.querySelector('[data-footprints-replay-arrow="back"]');
    const nextBtn = host.querySelector('[data-footprints-replay-arrow="ahead"]');
    if (!prevBtn || !nextBtn) return;
    const atNewest = m.index <= 0;
    const atOldest = m.index >= m.actions.length - 1;
    /* Left = back in time (older action); right = forward toward present (newer). */
    prevBtn.disabled = atOldest;
    nextBtn.disabled = atNewest;
    prevBtn.setAttribute('aria-disabled', atOldest ? 'true' : 'false');
    nextBtn.setAttribute('aria-disabled', atNewest ? 'true' : 'false');
  }

  function attachFloatingBunnyReplayControls() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    removeFloatingBunnyReplayControls();
    const m = multiPageReplay;
    if (!m) return;

    const wrap = document.createElement('div');
    wrap.className = FLOATING_BUNNY_REPLAY_ARROWS_CLASS;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Replay steps');

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'footprints-fab-replay-arrow-btn';
    prevBtn.setAttribute('data-footprints-replay-arrow', 'back');
    prevBtn.setAttribute('aria-label', 'Back one action');
    prevBtn.appendChild(makeFabReplayArrowSvg('left'));
    prevBtn.appendChild(makeFabReplayArrowKeyHint('<- key'));
    prevBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      advanceMultiPageReplayManual();
    });

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'footprints-fab-replay-arrow-btn';
    nextBtn.setAttribute('data-footprints-replay-arrow', 'ahead');
    nextBtn.setAttribute('aria-label', 'Forward one action');
    nextBtn.appendChild(makeFabReplayArrowSvg('right'));
    nextBtn.appendChild(makeFabReplayArrowKeyHint('-> key'));
    nextBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      retreatMultiPageReplay();
    });

    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    host.appendChild(wrap);
    updateFloatingBunnyReplayArrowState();

    const hereNorm = U.canonicalPageKey(location.href);
    if (m.originNorm && hereNorm !== m.originNorm) {
      const stayWrap = document.createElement('div');
      stayWrap.className = FLOATING_BUNNY_REPLAY_STAY_CLASS;
      const stayBtn = document.createElement('button');
      stayBtn.type = 'button';
      stayBtn.className = 'footprints-fab-replay-stay';
      stayBtn.textContent = 'Stay on this page.';
      stayBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!multiPageReplay) return;
        multiPageReplay.stayOnPage = true;
        finishMultiPageReplay();
      });
      stayWrap.appendChild(stayBtn);
      host.appendChild(stayWrap);
    }

    applyRetraceFabCardChrome(host);
    host.classList.add(FLOATING_BUNNY_REPLAY_QUIET_CLASS);
    scheduleNudgeFloatingFabIntoViewport();
  }

  function restoreFloatingBunnyNormalChrome(host) {
    if (!host) return;
    host.classList.remove(FLOATING_BUNNY_RETRACE_CARD_CLASS);
    const props = [
      'display',
      'flex-direction',
      'align-items',
      'justify-content',
      'gap',
      'padding',
      'background',
      'border',
      'border-radius',
      'box-shadow',
      'overflow',
    ];
    for (let i = 0; i < props.length; i++) {
      host.style.removeProperty(props[i]);
    }
    const btn = host.querySelector('button');
    if (btn) {
      btn.style.setProperty('box-shadow', FLOATING_BUNNY_BTN_SHADOW_IDLE, 'important');
    }
  }

  function removeFloatingBunnyReplayControls() {
    const host = document.getElementById(FLOATING_BUNNY_ID);
    if (!host) return;
    host.classList.remove(FLOATING_BUNNY_REPLAY_QUIET_CLASS);
    host.querySelector('.' + FLOATING_BUNNY_REPLAY_ARROWS_CLASS)?.remove();
    host.querySelector('.' + FLOATING_BUNNY_REPLAY_STAY_CLASS)?.remove();
    restoreFloatingBunnyNormalChrome(host);
  }

  function serializeMultiPageReplay() {
    const m = multiPageReplay;
    if (!m) return null;
    return {
      actions: m.actions,
      index: m.index,
      originHref: m.originHref,
      originNorm: m.originNorm,
      compact: m.compact,
      stayOnPage: m.stayOnPage,
      offerOpener: m.offerOpener,
      openerCtx: m.openerCtx || null,
      preReplayFabPos: m.preReplayFabPos || null,
      pendingEntryHint:
        m.pendingEntryHint === 'fromRight' || m.pendingEntryHint === 'fromLeft'
          ? m.pendingEntryHint
          : null,
    };
  }

  function abortMultiPageReplay(onCleared, expectedReplayRunId) {
    try {
      sessionStorage.removeItem(FP_SESSION_OPENER_KEY);
    } catch (e) {
      /* ignore */
    }
    multiPageReplay = null;
    chrome.runtime.sendMessage({ type: 'FOOTPRINTS_CLEAR_REPLAY_SESSION' }, () => {
      void chrome.runtime.lastError;
      if (
        typeof onCleared === 'function' &&
        (expectedReplayRunId == null || expectedReplayRunId === replayRunId)
      ) {
        onCleared();
      }
    });
  }

  function shouldNavigateToReplayStartUrl(originNorm, originHref, hereNorm) {
    return !!(
      originNorm &&
      originHref &&
      hereNorm &&
      /^https?:\/\//i.test(originHref) &&
      originNorm !== hereNorm
    );
  }

  /** Return the user to the tab URL where they started retrace (optional FAB restore after navigation). */
  function navigateToReplayStartUrl(originHref, preReplayFabPos) {
    const go = () => {
      try {
        location.assign(originHref);
      } catch (e) {
        warn('replay return', e);
      }
    };
    if (
      preReplayFabPos &&
      Number.isFinite(preReplayFabPos.left) &&
      Number.isFinite(preReplayFabPos.top)
    ) {
      chrome.runtime.sendMessage(
        {
          type: 'FOOTPRINTS_SET_PENDING_FAB_RESTORE',
          pos: { left: preReplayFabPos.left, top: preReplayFabPos.top },
        },
        () => {
          void chrome.runtime.lastError;
          go();
        }
      );
    } else {
      go();
    }
  }

  function finishMultiPageReplay() {
    const m = multiPageReplay;
    const replayRunIdAtFinish =
      m && Number.isFinite(m.replayRunId) ? m.replayRunId : replayRunId;
    const pinFab =
      m &&
      m.preReplayFabPos &&
      Number.isFinite(m.preReplayFabPos.left) &&
      Number.isFinite(m.preReplayFabPos.top)
        ? { left: m.preReplayFabPos.left, top: m.preReplayFabPos.top }
        : null;
    lastReplayGuideDocPoint = null;
    multiPageReplay = null;
    pendingReplayCrossPageArrow = null;
    stopActiveFootprintsReplay = null;
    try {
      sessionStorage.removeItem(REPLAY_CROSS_PAGE_ENTRY_SS_KEY);
      sessionStorage.removeItem('footprintsReplayEnterFromRight');
    } catch (e) {
      /* ignore */
    }
    teardownReplayUi();

    if (!m) {
      restoreLauncherAfterReplayStop(null);
      return;
    }

    const needOpener = m.offerOpener && m.openerCtx;
    const originNorm = m.originNorm;
    const originHref = m.originHref;
    const hereNorm = U.canonicalPageKey(location.href);
    const willAssignToOrigin =
      !m.stayOnPage && shouldNavigateToReplayStartUrl(originNorm, originHref, hereNorm);

    if (needOpener) {
      try {
        sessionStorage.setItem(FP_SESSION_OPENER_KEY, JSON.stringify(m.openerCtx));
      } catch (e) {
        /* ignore */
      }
    }

    if (!willAssignToOrigin) {
      restoreLauncherAfterReplayStop(pinFab);
    }

    abortMultiPageReplay(() => {
      if (willAssignToOrigin) {
        navigateToReplayStartUrl(originHref, m.preReplayFabPos);
        return;
      }
      if (needOpener) {
        tryShowPendingOpenerGateFromSessionStorage();
      }
    }, replayRunIdAtFinish);
  }

  function advanceMultiPageReplayManual() {
    const m = multiPageReplay;
    if (!m || !m.actions.length || m.index >= m.actions.length - 1) return;
    runReplayOverlayCleanup(true);
    forceRemoveReplayOverlayUi();
    stopActiveFootprintsReplay = null;

    m.index += 1;
    if (m.index >= m.actions.length) {
      finishMultiPageReplay();
      return;
    }
    /* Left green arrow → cross-page: exit left, next screen entry from the right (`fromRight`). */
    pendingReplayCrossPageArrow = 'left';
    chrome.runtime.sendMessage(
      { type: 'FOOTPRINTS_SET_REPLAY_SESSION', session: serializeMultiPageReplay() },
      () => void chrome.runtime.lastError
    );
    driveMultiPageReplayFromCurrentPage();
  }

  function retreatMultiPageReplay() {
    const m = multiPageReplay;
    if (!m || m.index <= 0) return;
    runReplayOverlayCleanup(true);
    forceRemoveReplayOverlayUi();
    stopActiveFootprintsReplay = null;

    m.index -= 1;
    /* Right green arrow → cross-page: exit right, next screen entry from the left (`fromLeft`). */
    pendingReplayCrossPageArrow = 'right';
    chrome.runtime.sendMessage(
      { type: 'FOOTPRINTS_SET_REPLAY_SESSION', session: serializeMultiPageReplay() },
      () => void chrome.runtime.lastError
    );
    driveMultiPageReplayFromCurrentPage();
  }

  function driveMultiPageReplayFromCurrentPage() {
    const m = multiPageReplay;
    if (!m) return;
    const action = m.actions[m.index];
    if (!action) {
      finishMultiPageReplay();
      return;
    }
    const needNorm = action.pageUrl ? U.canonicalPageKey(action.pageUrl) : '';
    const hereNorm = U.canonicalPageKey(location.href);
    if (needNorm && needNorm !== '__legacy__' && needNorm !== hereNorm) {
      const url = normalizeHrefForPage(action.pageUrl);
      if (url && /^https?:\/\//i.test(url)) {
        const crossArrow = pendingReplayCrossPageArrow;
        pendingReplayCrossPageArrow = null;
        const pt = lastReplayGuideDocPoint;
        const canExitSlide =
          pt &&
          pt.pageNorm === hereNorm &&
          Number.isFinite(pt.x) &&
          Number.isFinite(pt.y);
        const useExitSlide =
          canExitSlide && (crossArrow === 'left' || crossArrow === 'right');
        const entryTokenForNav =
          crossArrow === 'left' ? 'fromRight' : crossArrow === 'right' ? 'fromLeft' : null;
        if (entryTokenForNav) {
          m.pendingEntryHint = entryTokenForNav;
        }
        function assignReplayUrl() {
          if (!multiPageReplay) return;
          try {
            location.assign(url);
          } catch (e) {
            warn('replay navigate', e);
          }
        }
        chrome.runtime.sendMessage(
          { type: 'FOOTPRINTS_SET_REPLAY_SESSION', session: serializeMultiPageReplay() },
          () => {
            if (!multiPageReplay) return;
            if (useExitSlide) {
              runReplayCrossPageExitSlideThenNavigate(pt, assignReplayUrl, crossArrow);
            } else {
              /* Exit slide skipped (no valid guide point yet): still record entry direction so the next page’s intro matches the arrow. */
              if (entryTokenForNav) {
                try {
                  sessionStorage.setItem(REPLAY_CROSS_PAGE_ENTRY_SS_KEY, entryTokenForNav);
                } catch (e) {
                  /* ignore */
                }
              }
              assignReplayUrl();
            }
          }
        );
        return;
      }
    }
    const pendingEntryHint =
      m.pendingEntryHint === 'fromRight' || m.pendingEntryHint === 'fromLeft'
        ? m.pendingEntryHint
        : null;
    if (pendingEntryHint) {
      m.pendingEntryHint = null;
      chrome.runtime.sendMessage(
        { type: 'FOOTPRINTS_SET_REPLAY_SESSION', session: serializeMultiPageReplay() },
        () => void chrome.runtime.lastError
      );
    }
    pendingReplayCrossPageArrow = null;
    showReplayStepOverlay(action, m.compact, pendingEntryHint);
  }

  function beginMultiPageReplay(actions, opts) {
    const compact = !!(opts && opts.compact);
    const replayRunIdForSession = ++replayRunId;
    const maxSteps = CONFIG.MAX_REPLAY_ACTIONS;
    /* Newest recorded action first, then step backward in time (retrace). */
    const newestFirst = (actions || []).slice(-maxSteps).reverse();
    if (!newestFirst.length) {
      log('replay', 'no actions to replay');
      return;
    }
    const originHref = location.href;
    const originNorm = U.canonicalPageKey(originHref);
    multiPageReplay = {
      replayRunId: replayRunIdForSession,
      actions: newestFirst,
      index: 0,
      originHref,
      originNorm,
      compact,
      stayOnPage: false,
      offerOpener: !!(opts && opts.offerOpener),
      openerCtx: (opts && opts.openerCtx) || null,
      preReplayFabPos: capturePreReplayFabPosition(),
      pendingEntryHint: null,
    };
    lastReplayGuideDocPoint = null;
    chrome.runtime.sendMessage(
      { type: 'FOOTPRINTS_SET_REPLAY_SESSION', session: serializeMultiPageReplay() },
      () => void chrome.runtime.lastError
    );
    driveMultiPageReplayFromCurrentPage();
  }

  function tryResumeMultiPageReplaySession(onNoSession) {
    chrome.runtime.sendMessage({ type: 'FOOTPRINTS_GET_REPLAY_SESSION' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok || !res.session || !res.session.actions || !res.session.actions.length) {
        if (typeof onNoSession === 'function') onNoSession();
        return;
      }
      const s = res.session;
      const replayRunIdForSession = ++replayRunId;
      const idx = typeof s.index === 'number' ? s.index : 0;
      const preFab = s.preReplayFabPos;
      const preReplayFabPos =
        preFab &&
        typeof preFab.left === 'number' &&
        typeof preFab.top === 'number' &&
        Number.isFinite(preFab.left) &&
        Number.isFinite(preFab.top)
          ? { left: preFab.left, top: preFab.top }
          : null;
      multiPageReplay = {
        replayRunId: replayRunIdForSession,
        actions: s.actions,
        index: Math.min(Math.max(0, idx), s.actions.length - 1),
        originHref: s.originHref || '',
        originNorm: s.originNorm || '',
        compact: !!s.compact,
        stayOnPage: !!s.stayOnPage,
        offerOpener: !!s.offerOpener,
        openerCtx: s.openerCtx || null,
        preReplayFabPos,
        pendingEntryHint:
          s.pendingEntryHint === 'fromRight' || s.pendingEntryHint === 'fromLeft'
            ? s.pendingEntryHint
            : null,
      };
      lastReplayGuideDocPoint = null;
      driveMultiPageReplayFromCurrentPage();
    });
  }

  function tryShowPendingOpenerGateFromSessionStorage() {
    try {
      const raw = sessionStorage.getItem(FP_SESSION_OPENER_KEY);
      if (!raw) return;
      const ctx = JSON.parse(raw);
      sessionStorage.removeItem(FP_SESSION_OPENER_KEY);
      if (ctx && ctx.openerTabId != null) {
        showTakeMeToOpenerGate(ctx);
      }
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * The overlay carries the guide during retrace; keep the launcher’s duplicate mascot hidden so it
   * reads as one animal leaving the widget.
   */
  function setFloatingFabMascotVisibleInLauncher(visible) {
    const icon = document.querySelector('#footprints-floating-bunny .footprints-floating-bunny-img');
    if (!icon) return;
    if (visible) {
      icon.style.removeProperty('visibility');
      icon.style.removeProperty('opacity');
    } else {
      icon.style.setProperty('visibility', 'hidden', 'important');
      icon.style.setProperty('opacity', '0', 'important');
    }
  }

  /** @param {{ force?: boolean }} [opts] force: show launcher during replay even when “show on pages” is off */
  function ensureFloatingBunny(opts) {
    const forceForReplay = opts && opts.force === true;
    if (!cachedShowFloatingWidget && !forceForReplay) {
      removeFloatingLauncherDom();
      return;
    }
    ensureFloatingChewCss();
    ensureFloatingFabGlobalViewportListeners();
    const existing = document.getElementById(FLOATING_BUNNY_ID);
    if (existing) {
      removeFloatingLauncherDom();
    }

    const host = document.createElement('div');
    host.id = FLOATING_BUNNY_ID;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Retrace with ' + getFootprintsAnimal(cachedMascotId).label);
    btn.setAttribute('title', 'Retrace (drag me)');
    const icon = document.createElement('img');
    icon.src = cachedMascotUrl;
    icon.alt = '';
    icon.draggable = false;
    icon.className = 'footprints-floating-bunny-img';
    btn.appendChild(createFloatingBunnyGrassLayer());
    const stage = document.createElement('div');
    stage.className = 'fp-chew-stage';
    stage.appendChild(icon);
    if (cachedMascotId === 'bunny') stage.appendChild(createFloatingChewCarrot());
    if (cachedMascotId === 'owl') stage.appendChild(createFloatingOwlWorm());
    btn.appendChild(stage);

    const size = FLOATING_BUNNY_SIZE_PX;
    const start = getFloatingBunnyStartPosition(size);

    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('left', `${start.left}px`, 'important');
    host.style.setProperty('top', `${start.top}px`, 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('visibility', 'visible', 'important');
    host.style.setProperty('pointer-events', 'auto', 'important');

    btn.style.setProperty('all', 'initial', 'important');
    btn.style.setProperty('width', `${size}px`, 'important');
    btn.style.setProperty('height', `${size}px`, 'important');
    btn.style.setProperty('display', 'flex', 'important');
    btn.style.setProperty('align-items', 'flex-end', 'important');
    btn.style.setProperty('justify-content', 'center', 'important');
    btn.style.setProperty('box-sizing', 'border-box', 'important');
    btn.style.setProperty('border-radius', '999px', 'important');
    btn.style.setProperty('border', '2px solid rgba(74, 139, 90, 0.82)', 'important');
    btn.style.setProperty(
      'background',
      'linear-gradient(180deg,#cce8f4 0%,#dcefe6 28%,#d0ead8 52%,#c2e3cc 76%,#b4dbbf 100%)',
      'important'
    );
    btn.style.setProperty('box-shadow', FLOATING_BUNNY_BTN_SHADOW_IDLE, 'important');
    btn.style.setProperty('cursor', 'grab', 'important');
    btn.style.setProperty('user-select', 'none', 'important');
    btn.style.setProperty('-webkit-user-select', 'none', 'important');
    btn.style.setProperty('touch-action', 'none', 'important');
    btn.style.setProperty('pointer-events', 'auto', 'important');
    btn.style.setProperty('overflow', 'hidden', 'important');
    btn.style.setProperty('position', 'relative', 'important');

    icon.style.setProperty('display', 'block', 'important');
    icon.style.setProperty('width', '88%', 'important');
    icon.style.setProperty('height', '88%', 'important');
    icon.style.setProperty('object-fit', 'contain', 'important');
    icon.style.setProperty('object-position', 'center bottom', 'important');
    icon.style.setProperty('pointer-events', 'none', 'important');
    icon.style.setProperty('margin-bottom', '0', 'important');
    icon.style.setProperty(
      'filter',
      'drop-shadow(0 2px 6px rgba(15,35,12,0.22))',
      'important'
    );

    host.appendChild(btn);
    (document.body || document.documentElement).appendChild(host);
    syncFloatingFabFoxBerryClusterVisibility();
    syncFloatingFabRaccoonTrashWrap();
    syncFloatingFabRaccoonTrashHeapVisibility();
    syncFloatingFabRaccoonLauncherEatingVideoLayer();
    syncFloatingFabBunnyLauncherEatingVideoLayer();
    syncFloatingFabFoxLauncherEatingVideoLayer();
    syncFloatingFabOwlLauncherEatingVideoLayer();
    if (multiPageReplay) {
      attachFloatingBunnyReplayControls();
      /* Any path that rebuilds the FAB during retrace must re-hide the launcher mascot (e.g. delayed ensureFloatingBunny from scheduleFloatingBunnyEnsures). */
      setFloatingFabMascotVisibleInLauncher(false);
    }
    scheduleNudgeFloatingFabIntoViewport();

    let pointerId = null;
    let dragDX = 0;
    let dragDY = 0;
    let moved = false;
    let down = false;
    function beginPointerDrag(ev) {
      if (ev.button !== 0) return;
      down = true;
      moved = false;
      pointerId = ev.pointerId;
      const l = Number(host.style.left.replace('px', '')) || 0;
      const t = Number(host.style.top.replace('px', '')) || 0;
      dragDX = ev.clientX - l;
      dragDY = ev.clientY - t;
      btn.style.setProperty('cursor', 'grabbing', 'important');
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      ev.preventDefault();
    }
    function beginMouseDrag(ev) {
      if (ev.button !== 0 || pointerId !== null) return;
      down = true;
      moved = false;
      const l = Number(host.style.left.replace('px', '')) || 0;
      const t = Number(host.style.top.replace('px', '')) || 0;
      dragDX = ev.clientX - l;
      dragDY = ev.clientY - t;
      btn.style.setProperty('cursor', 'grabbing', 'important');
      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
      ev.preventDefault();
    }
    function isInteractiveLauncherSubcontrol(target) {
      if (!(target instanceof Element)) return false;
      const control = target.closest('button,a,input,textarea,select,[contenteditable=""],[contenteditable="true"]');
      if (!control) return false;
      return control !== btn;
    }

    function onMove(ev) {
      if (!down || ev.pointerId !== pointerId) return;
      const { w: bw, h: bh } = floatingFabHostBoxPx(host);
      const n = clampFabToViewport(ev.clientX - dragDX, ev.clientY - dragDY, bw, bh);
      const prevL = Number(host.style.left.replace('px', '')) || n.left;
      const prevT = Number(host.style.top.replace('px', '')) || n.top;
      if (Math.hypot(n.left - prevL, n.top - prevT) > 1.2) moved = true;
      host.style.setProperty('left', `${n.left}px`, 'important');
      host.style.setProperty('top', `${n.top}px`, 'important');
    }

    function onUp(ev) {
      if (!down || ev.pointerId !== pointerId) return;
      down = false;
      pointerId = null;
      btn.style.setProperty('cursor', 'grab', 'important');
      const left = Number(host.style.left.replace('px', '')) || 0;
      const top = Number(host.style.top.replace('px', '')) || 0;
      saveFloatingBunnyPos(left, top);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    }

    btn.addEventListener('pointerdown', beginPointerDrag);
    host.addEventListener('pointerdown', (ev) => {
      if (isInteractiveLauncherSubcontrol(ev.target)) return;
      beginPointerDrag(ev);
    });

    /* Mouse fallback for pages where Pointer Events are interfered with. */
    function onMouseMove(ev) {
      if (!down || pointerId !== null) return;
      const { w: bw, h: bh } = floatingFabHostBoxPx(host);
      const n = clampFabToViewport(ev.clientX - dragDX, ev.clientY - dragDY, bw, bh);
      const prevL = Number(host.style.left.replace('px', '')) || n.left;
      const prevT = Number(host.style.top.replace('px', '')) || n.top;
      if (Math.hypot(n.left - prevL, n.top - prevT) > 1.2) moved = true;
      host.style.setProperty('left', `${n.left}px`, 'important');
      host.style.setProperty('top', `${n.top}px`, 'important');
    }
    function onMouseUp() {
      if (!down || pointerId !== null) return;
      down = false;
      btn.style.setProperty('cursor', 'grab', 'important');
      const left = Number(host.style.left.replace('px', '')) || 0;
      const top = Number(host.style.top.replace('px', '')) || 0;
      saveFloatingBunnyPos(left, top);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
    }
    btn.addEventListener('mousedown', beginMouseDrag);
    host.addEventListener('mousedown', (ev) => {
      if (isInteractiveLauncherSubcontrol(ev.target)) return;
      beginMouseDrag(ev);
    });

    /* Prevent accidental arrow/Stay clicks after a card drag. */
    host.addEventListener(
      'click',
      (ev) => {
        if (!moved) return;
        moved = false;
        ev.preventDefault();
        ev.stopPropagation();
      },
      true,
    );

    btn.addEventListener('click', (ev) => {
      if (moved) {
        moved = false;
        ev.preventDefault();
        return;
      }
      startCompactReplay();
    });
  }

  function scheduleFloatingBunnyEnsures() {
    if (!cachedShowFloatingWidget) return;
    ensureFloatingBunny();
    setTimeout(() => {
      if (multiPageReplay) return;
      ensureFloatingBunny();
    }, 300);
    setTimeout(() => {
      if (multiPageReplay) return;
      ensureFloatingBunny();
    }, 1200);
  }

  function syncFloatingLauncherVisibility() {
    if (multiPageReplay) {
      ensureFloatingBunny({ force: true });
      return;
    }
    if (!cachedShowFloatingWidget) {
      removeFloatingLauncherDom();
      return;
    }
    scheduleFloatingBunnyEnsures();
  }

  function applyFootprintsOptionsFromStorage(r, opts) {
    const prevShow = cachedShowFloatingWidget;
    cachedShowFloatingWidget = r.fpShowFloatingWidget !== false;
    U.applyMaxReplayActionsFromUserSetting(
      r.fpMaxStoredActions != null ? r.fpMaxStoredActions : 4
    );
    if (opts && opts.initialBoot) {
      syncFloatingLauncherVisibility();
      return;
    }
    if (prevShow !== cachedShowFloatingWidget) {
      syncFloatingLauncherVisibility();
    }
  }

  function bootFootprintsFromStorage(onReady) {
    chrome.storage.local.get(
      {
        fpMascotAnimalId: FOOTPRINTS_DEFAULT_MASCOT_ID,
        fpShowFloatingWidget: true,
        fpMaxStoredActions: 4,
      },
      (r) => {
        if (chrome.runtime.lastError) {
          applyMascotFromStorageRecord({ fpMascotAnimalId: FOOTPRINTS_DEFAULT_MASCOT_ID });
          U.applyMaxReplayActionsFromUserSetting(4);
          scheduleFloatingBunnyEnsures();
          if (typeof onReady === 'function') onReady();
          return;
        }
        applyMascotFromStorageRecord(r);
        applyFootprintsOptionsFromStorage(r, { initialBoot: true });
        if (typeof onReady === 'function') onReady();
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.prototype.hasOwnProperty.call(changes, FOOTPRINTS_MASCOT_STORAGE_KEY)) {
      applyMascotFromStorageRecord({
        fpMascotAnimalId: changes[FOOTPRINTS_MASCOT_STORAGE_KEY].newValue,
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(changes, FP_SHOW_FLOATING_WIDGET_KEY) ||
      Object.prototype.hasOwnProperty.call(changes, FP_MAX_STORED_ACTIONS_KEY)
    ) {
      chrome.storage.local.get(
        {
          fpMascotAnimalId: FOOTPRINTS_DEFAULT_MASCOT_ID,
          fpShowFloatingWidget: true,
          fpMaxStoredActions: 4,
        },
        (r) => {
          if (chrome.runtime.lastError) return;
          applyFootprintsOptionsFromStorage(r, {});
        }
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Overlay + replay animation (~REPLAY_TOTAL_MS for all hops)
  // ---------------------------------------------------------------------------

  /**
   * Replay / link-hint guide sprite: PNG fallback; bunny/raccoon/fox/owl use `.m4v` clips where available.
   * @param {{
   *   retraceTrip?: { fromDoc: { x: number, y: number }, toDoc: { x: number, y: number } },
   *   retraceExitArrow?: 'left' | 'right'
   * }} [opts]
   */
  function createRabbitHopMascot(opts) {
    opts = opts || {};
    if (cachedMascotId === 'bunny') {
      if (opts.retraceTrip) {
        const pick = pickBunnyRetraceVideoPath(opts.retraceTrip.fromDoc, opts.retraceTrip.toDoc);
        return createBunnyRetraceVideoMascot(
          pick.path,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          pick.mirrorX,
        );
      }
      if (opts.retraceExitArrow === 'left' || opts.retraceExitArrow === 'right') {
        return createBunnyRetraceVideoMascot(
          FP_BUNNY_WALK_RIGHT_M4V,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          opts.retraceExitArrow === 'left',
        );
      }
    }
    if (cachedMascotId === 'owl') {
      if (opts.retraceTrip) {
        const pick = pickOwlRetraceVideoPath(opts.retraceTrip.fromDoc, opts.retraceTrip.toDoc);
        return createBunnyRetraceVideoMascot(
          pick.path,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          pick.mirrorX,
        );
      }
      if (opts.retraceExitArrow === 'left' || opts.retraceExitArrow === 'right') {
        return createBunnyRetraceVideoMascot(
          FP_OWL_FLY_LEFT_M4V,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          opts.retraceExitArrow === 'right',
        );
      }
    }
    if (cachedMascotId === 'raccoon') {
      if (opts.retraceTrip) {
        const pick = pickRaccoonRetraceVideoPath(opts.retraceTrip.fromDoc, opts.retraceTrip.toDoc);
        return createRaccoonRetraceVideoMascot(
          pick.path,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          pick.mirrorX,
        );
      }
      if (opts.retraceExitArrow === 'left' || opts.retraceExitArrow === 'right') {
        return createRaccoonRetraceVideoMascot(
          FP_RACCOON_WALK_M4V,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          opts.retraceExitArrow === 'left',
        );
      }
    }
    if (cachedMascotId === 'fox') {
      if (opts.retraceTrip) {
        const pick = pickFoxRetraceVideoPath(opts.retraceTrip.fromDoc, opts.retraceTrip.toDoc);
        if (pick.path) {
          return createFoxRetraceVideoMascot(
            pick.path,
            (img) => {
              applyRetraceMascotGlow(img);
            },
            pick.mirrorX,
          );
        }
      }
      if (opts.retraceExitArrow === 'left' || opts.retraceExitArrow === 'right') {
        return createFoxRetraceVideoMascot(
          FP_FOX_WALK_STRAIGHT_M4V,
          (img) => {
            applyRetraceMascotGlow(img);
          },
          false,
        );
      }
    }
    const img = document.createElement('img');
    img.className = 'footprints-rabbit-mascot';
    img.src = cachedMascotUrl;
    const animal = getFootprintsAnimal(cachedMascotId);
    img.alt = animal.label + ' guide';
    img.draggable = false;
    img.decoding = 'async';
    return img;
  }

  function applyRetraceMascotGlow(el) {
    if (!el) return;
    if (isRaccoonRetraceWalkStack(el) || isBunnyRetraceWalkStack(el) || isFoxRetraceWalkStack(el)) {
      el.style.setProperty('position', 'relative', 'important');
      el.style.setProperty('z-index', '2', 'important');
      const subtle =
        'drop-shadow(0 2px 5px rgba(0,0,0,0.35)) drop-shadow(0 0 14px rgba(42,122,78,0.4))';
      el
        .querySelectorAll(
          'canvas.footprints-raccoon-retrace-video, canvas.footprints-bunny-retrace-video, canvas.footprints-fox-retrace-video'
        )
        .forEach((c) => {
        c.style.setProperty('filter', subtle, 'important');
        c.style.setProperty('-webkit-filter', subtle, 'important');
        if (c.classList.contains('footprints-fox-retrace-video')) {
          c.style.setProperty('mix-blend-mode', 'normal', 'important');
        } else {
          c.style.setProperty('mix-blend-mode', 'multiply', 'important');
        }
        });
      return;
    }
    el.style.setProperty('position', 'relative', 'important');
    el.style.setProperty('z-index', '2', 'important');
    /* Heavy glow reads as a solid white/green slab on <video> (filters × light mat). PNG only. */
    if (el.tagName === 'VIDEO') {
      const subtle =
        'drop-shadow(0 2px 5px rgba(0,0,0,0.35)) drop-shadow(0 0 14px rgba(42,122,78,0.4))';
      el.style.setProperty('filter', subtle, 'important');
      el.style.setProperty('-webkit-filter', subtle, 'important');
      el.style.setProperty('mix-blend-mode', 'multiply', 'important');
      return;
    }
    const glow =
      'drop-shadow(1px 0 0 rgba(255,255,255,0.84)) drop-shadow(-1px 0 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 1px 0 rgba(255,255,255,0.84)) drop-shadow(0 -1px 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 2px 8px rgba(0,0,0,0.16)) drop-shadow(0 0 58px rgba(56,150,96,0.9)) ' +
      'drop-shadow(0 0 126px rgba(42,122,78,0.8))';
    el.style.setProperty('filter', glow, 'important');
    el.style.setProperty('-webkit-filter', glow, 'important');
    el.style.removeProperty('mix-blend-mode');
  }

  function createRetraceMascotHalo() {
    const halo = document.createElement('div');
    halo.className = 'footprints-retrace-mascot-halo';
    halo.style.cssText =
      'position:absolute;left:50%;top:54%;width:86px;height:86px;transform:translate(-50%,-50%);' +
      'border-radius:999px;pointer-events:none;z-index:1;' +
      'background:radial-gradient(circle, rgba(62,170,108,0.72) 0%, rgba(44,130,82,0.48) 46%, rgba(34,98,62,0.24) 68%, rgba(34,98,62,0) 100%);' +
      'filter:blur(2.8px);-webkit-filter:blur(2.8px);';
    return halo;
  }

  function footprintSvg() {
    return (
      '<svg viewBox="0 0 24 30" aria-hidden="true">' +
      '<ellipse cx="12" cy="10" rx="6" ry="8" opacity="0.9"/>' +
      '<ellipse cx="9" cy="22" rx="4" ry="5" opacity="0.85"/>' +
      '<ellipse cx="16" cy="22" rx="4" ry="5" opacity="0.85"/>' +
      '</svg>'
    );
  }

  /**
   * Canine-style trail (fox / raccoon): rounded main pad + four toe ovals; no claw marks.
   * @param {string} fill
   * @param {string} stroke
   */
  function footprintSvgTrailCanine(fill, stroke) {
    const sw = '2.05';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 58" aria-hidden="true">' +
      '<g fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      sw +
      '" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M16.6 25.4Q24 21.6 31.4 25.4C37 27.3 39.2 33.2 38.8 40C38.3 48 32 53.5 24 53.5S9.8 48 9.2 40C8.8 33.2 11 27.3 16.6 25.4Z"/>' +
      '<ellipse cx="10.3" cy="19.2" rx="4.95" ry="7.25" transform="rotate(-24 10.3 19.2)"/>' +
      '<ellipse cx="18" cy="10.35" rx="5.1" ry="8.35" transform="rotate(-8 18 10.35)"/>' +
      '<ellipse cx="30" cy="10.35" rx="5.1" ry="8.35" transform="rotate(8 30 10.35)"/>' +
      '<ellipse cx="37.7" cy="19.2" rx="4.95" ry="7.25" transform="rotate(24 37.7 19.2)"/>' +
      '</g></svg>'
    );
  }

  function footprintSvgTrailFox() {
    return footprintSvgTrailCanine('#e3cdb0', '#3a2315');
  }

  function footprintSvgTrailRaccoon() {
    return footprintSvgTrailCanine('#c9c6c1', '#3f3d3a');
  }

  /**
   * Owl / bird: four toes fused at a central hub — three long forward digits (tips read as talons) + one short rear hallux.
   * Same ink as bunny trail for replay scrim contrast.
   */
  function footprintSvgTrailOwl() {
    const stroke = '#3a2315';
    const fill = '#e3cdb0';
    const sw = '2.05';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 56" aria-hidden="true">' +
      '<g fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      sw +
      '" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M24 49.5C19.8 49.5 17.4 46 18 42C14.5 36.5 9.5 27 7.8 19.5C7 14.5 9 11 11.5 11.8L14 15.5C16 22 18 29 20 33.5C21.2 36 22.5 37 23.2 37.2L20.2 15L24 10.8L27.8 15L26.8 37.2C26.5 37 27.8 36 29 33.5C31 29 33 22 35 15.5L37.5 11.8C40 11 42 14.5 41.2 19.5C39.5 27 34.5 36.5 31 42C31.6 46 29.2 49.5 24 49.5Z"/>' +
      '</g></svg>'
    );
  }

  /**
   * Bunny-track: three toes + pad (SVG) — default when mascot is bunny only.
   */
  function footprintSvgTrail() {
    if (cachedMascotId === 'fox') {
      return footprintSvgTrailFox();
    }
    if (cachedMascotId === 'raccoon') {
      return footprintSvgTrailRaccoon();
    }
    if (cachedMascotId === 'owl') {
      return footprintSvgTrailOwl();
    }
    const stroke = '#3a2315';
    const fill = '#e3cdb0';
    const sw = '2.05';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 52" aria-hidden="true">' +
      '<ellipse cx="20" cy="36.5" rx="8.8" ry="14.2" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      sw +
      '" stroke-linecap="round"/>' +
      '<ellipse cx="12.2" cy="13.2" rx="4.1" ry="4.7" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      sw +
      '" stroke-linecap="round"/>' +
      '<ellipse cx="20" cy="8.3" rx="4" ry="5" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      sw +
      '" stroke-linecap="round"/>' +
      '<ellipse cx="27.8" cy="13.2" rx="4.1" ry="4.7" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      sw +
      '" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  /**
   * Ask before navigating away so replay coordinates match the recorded page.
   * @param {{ slice: object[], needNav: boolean, navigateUrl: string, pageNorm: string }} pick
   * @param {object[]} allTabActions full tab bucket (used to replay every step on the target URL after navigation).
   * @param {{ onClose?: () => void }} [options] If set, onClose runs when the user dismisses without navigating (Not now / scrim).
   */
  function showReplayNavigateGate(pick, allTabActions, options) {
    const onDismiss = options && options.onClose;
    ensureOverlayCss();
    const root = document.createElement('div');
    root.id = 'footprints-navigate-gate';
    root.className = 'footprints-root footprints-interactive';
    root.setAttribute('data-footprints-gate', '1');

    const scrim = document.createElement('div');
    scrim.className = 'footprints-scrim';

    const panel = document.createElement('div');
    panel.className = 'footprints-gate-panel';

    const p = document.createElement('p');
    p.className = 'footprints-gate-msg';
    p.textContent =
      'Your last steps were recorded on another page in this tab. Go back to that page so your guide can retrace them.';

    const row = document.createElement('div');
    row.className = 'footprints-gate-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'footprints-gate-secondary';
    cancel.textContent = 'Not now';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'footprints-gate-primary';
    go.textContent = 'Go there';

    function removeGate() {
      root.remove();
    }

    function dismiss() {
      removeGate();
      if (onDismiss) {
        try {
          onDismiss();
        } catch (e) {
          warn('replay gate onClose', e);
        }
      }
    }

    cancel.addEventListener('click', dismiss);
    scrim.addEventListener('click', dismiss);
    go.addEventListener('click', () => {
      const max = CONFIG.MAX_REPLAY_ACTIONS;
      let actionsToReplay = U.actionsToReplayAfterNavigate(allTabActions, pick.pageNorm);
      if (!actionsToReplay.length && pick.slice && pick.slice.length) {
        actionsToReplay = pick.slice.slice(-max);
      }
      log('replay gate', 'navigate + pending replay', actionsToReplay.length, 'step(s)');
      chrome.runtime.sendMessage(
        {
          type: 'FOOTPRINTS_STORE_PENDING_REPLAY',
          actions: actionsToReplay,
          pageNorm: pick.pageNorm,
        },
        (res) => {
          removeGate();
          if (chrome.runtime.lastError) {
            warn('replay gate', chrome.runtime.lastError.message);
            return;
          }
          if (!res || !res.ok) {
            warn('replay gate', 'could not save pending replay');
            return;
          }
          try {
            location.assign(pick.navigateUrl);
          } catch (e) {
            warn('navigate', e);
          }
        }
      );
    });

    row.appendChild(cancel);
    row.appendChild(go);
    panel.appendChild(p);
    panel.appendChild(row);
    root.appendChild(scrim);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
  }

  /**
   * This tab has no stored steps, but another tab in the same window does — offer to jump there before retrace.
   * @param {{ tabId: number, windowId?: number, title?: string, count?: number }} peer
   */
  function showSwitchToPeerTabForReplayGate(peer) {
    if (!peer || peer.tabId == null) return;
    ensureOverlayCss();
    const root = document.createElement('div');
    root.id = 'footprints-peer-tab-gate';
    root.className = 'footprints-root footprints-interactive';
    root.setAttribute('data-footprints-peer-tab-gate', '1');

    const scrim = document.createElement('div');
    scrim.className = 'footprints-scrim';

    const panel = document.createElement('div');
    panel.className = 'footprints-gate-panel';

    const p = document.createElement('p');
    p.className = 'footprints-gate-msg';
    const rawTitle =
      peer.title && String(peer.title).trim()
        ? String(peer.title).trim()
        : 'another tab';
    const titleShort = rawTitle.length > 52 ? rawTitle.slice(0, 50) + '…' : rawTitle;
    const n =
      typeof peer.count === 'number' && peer.count > 0 ? peer.count : 'some';
    p.textContent =
      'Recorded steps live on another tab (“' +
      titleShort +
      '”, ' +
      n +
      ' step' +
      (peer.count === 1 ? '' : 's') +
      '). Switch there to run retrace from the circular launcher or extension button.';

    const row = document.createElement('div');
    row.className = 'footprints-gate-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'footprints-gate-secondary';
    cancel.textContent = 'Dismiss';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'footprints-gate-primary';
    go.textContent = 'Switch tab';

    function close() {
      root.remove();
    }
    cancel.addEventListener('click', close);
    scrim.addEventListener('click', close);
    go.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          type: 'FOOTPRINTS_ACTIVATE_PEER_TAB_FOR_REPLAY',
          peerTabId: peer.tabId,
        },
        (res) => {
          close();
          if (chrome.runtime.lastError || !res || !res.ok) {
            warn(
              'switch peer tab',
              chrome.runtime.lastError && chrome.runtime.lastError.message,
            );
          }
        },
      );
    });

    row.appendChild(cancel);
    row.appendChild(go);
    panel.appendChild(p);
    panel.appendChild(row);
    root.appendChild(scrim);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
  }

  /**
   * After a short replay on a tab opened from a link, offer to focus the parent tab and show the link.
   * @param {{ openerTabId: number, anchor: object }} ctx
   */
  function showTakeMeToOpenerGate(ctx) {
    if (!ctx || ctx.openerTabId == null) return;
    ensureOverlayCss();
    const root = document.createElement('div');
    root.id = 'footprints-opener-gate';
    root.className = 'footprints-root footprints-interactive';
    root.setAttribute('data-footprints-opener-gate', '1');

    const scrim = document.createElement('div');
    scrim.className = 'footprints-scrim';

    const panel = document.createElement('div');
    panel.className = 'footprints-gate-panel';

    const p = document.createElement('p');
    p.className = 'footprints-gate-msg';
    p.textContent =
      'This tab was opened from another tab. Open the previous tab and your guide will show you the link.';

    const row = document.createElement('div');
    row.className = 'footprints-gate-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'footprints-gate-secondary';
    cancel.textContent = 'Not now';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'footprints-gate-primary';
    go.textContent = 'Open tab';

    function close() {
      root.remove();
    }
    cancel.addEventListener('click', close);
    scrim.addEventListener('click', close);
    go.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'FOOTPRINTS_ACTIVATE_OPENER_FOR_CHILD' }, (res) => {
        close();
        if (chrome.runtime.lastError || !res || !res.ok) {
          warn('activate opener', chrome.runtime.lastError && chrome.runtime.lastError.message);
        }
      });
    });

    row.appendChild(cancel);
    row.appendChild(go);
    panel.appendChild(p);
    panel.appendChild(row);
    root.appendChild(scrim);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
  }

  /**
   * Retrace replay (newest action first, then older): step with green arrows; when done or exiting early,
   * return to the start URL unless the user chose “Stay on this page.” (ends retrace and remains on the current page).
   * Optional opener gate after finish.
   * @param {object[]} actions
   */
  function startReplayFromActions(actions, opts) {
    const compact = !!(opts && opts.compact);
    const run = () => {
      const slice = (actions || []).slice(-CONFIG.MAX_REPLAY_ACTIONS);
      if (!slice.length) {
        getChildOpenContext((ctx) => {
          if (ctx && ctx.openerTabId != null) {
            showTakeMeToOpenerGate(ctx);
            return;
          }
          chrome.runtime.sendMessage({ type: 'FOOTPRINTS_GET_OTHER_TAB_WITH_STEPS' }, (peerRes) => {
            void chrome.runtime.lastError;
            const peer = peerRes && peerRes.ok && peerRes.peer;
            if (peer && peer.tabId != null && peer.count > 0) {
              showSwitchToPeerTabForReplayGate(peer);
            } else {
              log('replay', 'no actions to replay');
            }
          });
        });
        return;
      }
      const count = (actions || []).length;
      getChildOpenContext((ctx) => {
        const offerOpener = ctx && count < MIN_ACTIONS_FOR_OPENER_TAB_PROMPT;
        beginMultiPageReplay(actions, {
          compact,
          offerOpener,
          openerCtx: offerOpener ? ctx : null,
        });
      });
    };

    chrome.storage.local.get({ fpMaxStoredActions: 4 }, (r) => {
      if (!chrome.runtime.lastError) {
        U.applyMaxReplayActionsFromUserSetting(
          r.fpMaxStoredActions != null ? r.fpMaxStoredActions : 4
        );
      }
      run();
    });
  }

  /**
   * Scroll the recorded element into view (nested overflow regions + window). Must run before
   * {@link FootprintsUtils.resolveReplayDocPoint} so doc-space coords match visible layout on SPAs.
   */
  function scrollReplayAnchorIntoViewBeforeDocPoint(action) {
    if (!action || !action.descriptor) return;
    const el = U.resolveElement(action.descriptor);
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch (e) {
      /* iframe / shadow / rare host restrictions */
    }
  }

  /**
   * Single retrace step: left arrow = back (older action); right = forward (newer); Done ends replay.
   * @param {object} action
   * @param {boolean} compact
   * @param {'fromRight'|'fromLeft'|null|undefined} entryHintFromReplaySession
   */
  function showReplayStepOverlay(action, compact, entryHintFromReplaySession) {
    runReplayOverlayCleanup(true);
    forceRemoveReplayOverlayUi();
    stopActiveFootprintsReplay = null;

    ensureOverlayCss();
    ensureFloatingBunny({ force: true });
    attachFloatingBunnyReplayControls();
    setFloatingFabMascotVisibleInLauncher(false);
    clearFloatingChewIdleTimer();
    {
      const fabPre = document.getElementById(FLOATING_BUNNY_ID);
      if (fabPre) {
        fabPre.classList.remove('fp-chew-active');
        syncRaccoonLauncherScrollChewVideo(false);
        syncBunnyLauncherScrollChewVideo(false);
        syncFoxLauncherScrollChewVideo(false);
        syncOwlLauncherScrollChewVideo(false);
      }
    }

    try {
      const ae = document.activeElement;
      if (ae && typeof ae.blur === 'function') ae.blur();
    } catch (e) {
      /* ignore */
    }

    const root = document.createElement('div');
    root.id = 'footprints-overlay-root';
    root.className = compact
      ? 'footprints-root footprints-compact-replay'
      : 'footprints-root footprints-interactive';
    root.setAttribute('data-footprints-overlay', '1');

    /* Sync styles: host pages often use * { animation: none !important } — keep paws visible */
    const syncStyle = document.createElement('style');
    syncStyle.textContent =
      '#footprints-replay-guide-layer .footprints-trail-inner{' +
      'opacity:0.95!important;width:17px!important;height:23px!important;' +
      'transform-origin:50% 82%!important;animation:none!important;}' +
      '#footprints-replay-guide-layer .footprints-trail-inner svg{' +
      'width:100%!important;height:100%!important;display:block!important;object-fit:contain!important;}' +
      '#footprints-replay-guide-layer .footprints-footprints-layer{z-index:22!important;position:absolute!important;inset:0!important;pointer-events:none!important;overflow:visible!important;}' +
      '#footprints-replay-guide-layer .footprints-trail-wrap{position:absolute!important;pointer-events:none!important;}' +
      '#footprints-replay-guide-layer .footprints-rabbit-wrap{' +
      'position:absolute!important;z-index:24!important;width:76px!important;height:76px!important;' +
      'margin-left:-38px!important;margin-top:-38px!important;pointer-events:none!important;' +
      'border:none!important;outline:none!important;box-shadow:none!important;background:transparent!important;transform:translateY(-52px)!important;}' +
      '#footprints-replay-guide-layer video.footprints-raccoon-retrace-video,' +
      '#footprints-replay-guide-layer video.footprints-bunny-retrace-video,' +
      '#footprints-replay-guide-layer video.footprints-fox-retrace-video,' +
      '#footprints-replay-guide-layer canvas.footprints-raccoon-retrace-video,' +
      '#footprints-replay-guide-layer canvas.footprints-bunny-retrace-video,' +
      '#footprints-replay-guide-layer canvas.footprints-fox-retrace-video{border:none!important;outline:none!important;box-shadow:none!important;' +
      'background:transparent!important;background-color:transparent!important;pointer-events:none!important;' +
      'width:100%!important;height:100%!important;display:block!important;object-fit:contain!important;object-position:center center!important;' +
      'mix-blend-mode:multiply!important;' +
      'filter:drop-shadow(0 2px 5px rgba(0,0,0,0.32)) drop-shadow(0 0 14px rgba(42,122,78,0.42))!important;' +
      '-webkit-filter:drop-shadow(0 2px 5px rgba(0,0,0,0.32)) drop-shadow(0 0 14px rgba(42,122,78,0.42))!important;}' +
      '#footprints-replay-guide-layer video.footprints-fox-retrace-video,' +
      '#footprints-replay-guide-layer canvas.footprints-fox-retrace-video{mix-blend-mode:normal!important;}' +
      '#footprints-replay-guide-layer img.footprints-rabbit-mascot{border:none!important;outline:none!important;box-shadow:none!important;background:transparent!important;' +
      'pointer-events:none!important;width:100%!important;height:100%!important;display:block!important;object-fit:contain!important;object-position:center center!important;' +
      'filter:' +
      'drop-shadow(1px 0 0 rgba(255,255,255,0.84)) drop-shadow(-1px 0 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 1px 0 rgba(255,255,255,0.84)) drop-shadow(0 -1px 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 2px 8px rgba(0,0,0,0.12)) drop-shadow(0 0 42px rgba(90,195,130,0.9)) ' +
      'drop-shadow(0 0 92px rgba(90,195,130,0.78))!important;' +
      '-webkit-filter:' +
      'drop-shadow(1px 0 0 rgba(255,255,255,0.84)) drop-shadow(-1px 0 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 1px 0 rgba(255,255,255,0.84)) drop-shadow(0 -1px 0 rgba(255,255,255,0.84)) ' +
      'drop-shadow(0 2px 8px rgba(0,0,0,0.12)) drop-shadow(0 0 42px rgba(90,195,130,0.9)) ' +
      'drop-shadow(0 0 92px rgba(90,195,130,0.78))!important;}' +
      '#footprints-overlay-root .footprints-replay-target-fill{' +
      'position:fixed!important;pointer-events:none!important;z-index:18!important;' +
      'box-sizing:border-box!important;' +
      'background:rgba(74,180,108,0.38)!important;' +
      'box-shadow:' +
      '0 0 0 2px rgba(52,150,88,0.65),' +
      '0 0 14px 4px rgba(90,195,130,0.5),' +
      '0 0 28px 10px rgba(28,120,68,0.35)!important;' +
      'transition:opacity 0.2s ease,box-shadow 0.2s ease!important;}' +
      '@keyframes footprints-replay-trail-fade{from{opacity:0.9;}to{opacity:0;}}' +
      '#footprints-replay-guide-layer .footprints-trail-inner.footprints-trail-fade{' +
      'animation:footprints-replay-trail-fade 0.45s ease-out 1.5s forwards!important;}';
    root.appendChild(syncStyle);

    const scrim = document.createElement('div');
    scrim.className = 'footprints-scrim';

    const replayTargetFill = document.createElement('div');
    replayTargetFill.className = 'footprints-replay-target-fill';
    replayTargetFill.setAttribute('aria-hidden', 'true');
    replayTargetFill.style.display = 'none';

    const label = document.createElement('div');
    label.className = 'footprints-label';
    label.textContent = 'Retracing my footsteps…';

    const rabbitWrap = document.createElement('div');
    rabbitWrap.className = 'footprints-rabbit-wrap';
    rabbitWrap.style.overflow = 'visible';
    rabbitWrap.appendChild(createRetraceMascotHalo());
    rabbitWrap.style.transition = 'none';
    rabbitWrap.style.zIndex = '24';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'footprints-dismiss';
    dismiss.textContent = 'Done';
    const doneBaseShadow =
      '0 1px 2px rgba(15, 23, 42, 0.08), 0 4px 14px rgba(50, 160, 88, 0.25)';
    const doneHoverShadow =
      '0 1px 3px rgba(15, 23, 42, 0.1), 0 6px 20px rgba(50, 160, 88, 0.32)';
    dismiss.style.setProperty('color', '#ffffff', 'important');
    dismiss.style.setProperty('border', 'none', 'important');
    dismiss.style.setProperty(
      'background',
      'linear-gradient(180deg,#4bb46b 0%,#2f9854 100%)',
      'important',
    );
    dismiss.style.setProperty('box-shadow', doneBaseShadow, 'important');
    dismiss.style.setProperty(
      'transition',
      'filter 0.16s ease, box-shadow 0.16s ease, transform 0.08s ease',
      'important',
    );
    dismiss.addEventListener('pointerenter', () => {
      dismiss.style.setProperty('filter', 'brightness(1.05)', 'important');
      dismiss.style.setProperty('box-shadow', doneHoverShadow, 'important');
    });
    dismiss.addEventListener('pointerleave', () => {
      dismiss.style.setProperty('filter', 'none', 'important');
      dismiss.style.setProperty('box-shadow', doneBaseShadow, 'important');
    });

    const topRight = document.createElement('div');
    topRight.className = 'footprints-overlay-top-right';
    topRight.appendChild(dismiss);

    root.appendChild(scrim);
    root.appendChild(replayTargetFill);
    root.appendChild(label);
    root.appendChild(topRight);

    const footprintsLayer = document.createElement('div');
    footprintsLayer.className = 'footprints-footprints-layer';
    footprintsLayer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:22;overflow:visible;';

    const guideLayer = document.createElement('div');
    guideLayer.id = REPLAY_GUIDE_LAYER_ID;
    guideLayer.setAttribute('data-footprints-replay-guide', '1');
    guideLayer.style.cssText =
      'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    guideLayer.appendChild(footprintsLayer);
    guideLayer.appendChild(rabbitWrap);

    document.documentElement.appendChild(root);
    {
      const fabEl = document.getElementById(FLOATING_BUNNY_ID);
      const bh = document.body;
      if (fabEl && fabEl.parentNode) {
        fabEl.parentNode.insertBefore(guideLayer, fabEl.nextSibling);
      } else if (bh) {
        bh.appendChild(guideLayer);
      } else {
        document.documentElement.appendChild(guideLayer);
      }
    }

    /**
     * Replay-only: fixed overlay matching the target rect (filled green + outer glow).
     * Host nodes often use overflow:hidden, which clips inset shadows on the element itself.
     */
    let replayGlowEl = null;
    function syncReplayTargetFillBox() {
      if (!replayGlowEl || !document.contains(replayGlowEl)) {
        replayTargetFill.style.setProperty('display', 'none', 'important');
        return;
      }
      const r = replayGlowEl.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) {
        replayTargetFill.style.setProperty('display', 'none', 'important');
        return;
      }
      replayTargetFill.style.setProperty('display', 'block', 'important');
      replayTargetFill.style.setProperty('left', `${r.left}px`, 'important');
      replayTargetFill.style.setProperty('top', `${r.top}px`, 'important');
      replayTargetFill.style.setProperty('width', `${r.width}px`, 'important');
      replayTargetFill.style.setProperty('height', `${r.height}px`, 'important');
    }
    function clearReplayTargetGlow() {
      replayTargetFill.style.setProperty('display', 'none', 'important');
      replayGlowEl = null;
    }
    function setReplayTargetGlowForAction(action) {
      clearReplayTargetGlow();
      if (!action || action.type === 'pause' || !action.descriptor) return;
      const el = U.resolveElement(action.descriptor);
      if (!el || !document.contains(el)) return;
      replayGlowEl = el;
      syncReplayTargetFillBox();
    }

    let replayAlive = true;
    let introMotionDone = false;
    let introTrailRaf = 0;
    let introTrailSampling = false;
    let introTrailPrevDoc = null;
    /** Last doc point where we stamped; intro only spawns again after this much travel (stops squishing near the guide). */
    let introTrailLastStampDoc = null;
    const INTRO_TRAIL_MIN_STAMP_GAP_DOC = 38;

    const trailFadingPrints = [];
    const TRAIL_FEET_BACK_DOC = 12;
    const TRAIL_STEP_BACK_DOC = 40;
    const MAX_TRAIL_PRINTS = 72;
    let trailLastPositionedDoc = null;

    /**
     * Guide uses fixed overlay + px left/top. Inline style jumps to the transition end immediately;
     * getComputedStyle follows the animated values so the trail can sample motion during the intro glide.
     */
    function readRabbitAnchorDoc() {
      const cs = getComputedStyle(rabbitWrap);
      let lx = parseFloat(cs.left);
      let ly = parseFloat(cs.top);
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) {
        lx = parseFloat(rabbitWrap.style.left) || 0;
        ly = parseFloat(rabbitWrap.style.top) || 0;
      }
      const x = window.scrollX + lx;
      const y = window.scrollY + ly;
      return { x, y };
    }

    function stopIntroTrailLoop() {
      introTrailSampling = false;
      if (introTrailRaf) {
        cancelAnimationFrame(introTrailRaf);
        introTrailRaf = 0;
      }
    }

    function pruneTrailIfNeeded() {
      while (trailFadingPrints.length > MAX_TRAIL_PRINTS) {
        const dead = trailFadingPrints.shift();
        if (dead && dead.el && dead.el.parentNode) dead.el.remove();
      }
    }

    function syncTrailFadingPrintsForScroll() {
      for (let j = 0; j < trailFadingPrints.length; j++) {
        const o = trailFadingPrints[j];
        o.el.style.left = `${o.docX - window.scrollX}px`;
        o.el.style.top = `${o.docY - window.scrollY}px`;
      }
    }

    function spawnSingleFadingTrailPrint(docX, docY, rotDeg) {
      if (!footprintsLayer) return;
      const wrap = document.createElement('div');
      wrap.className = 'footprints-trail-wrap';
      const inner = document.createElement('div');
      inner.className = 'footprints-trail-inner footprints-trail-fade';
      inner.innerHTML = footprintSvgTrail();
      inner.style.setProperty('width', '17px', 'important');
      inner.style.setProperty('height', '23px', 'important');
      inner.style.setProperty('transform-origin', '50% 82%', 'important');
      inner.style.setProperty('opacity', '0.95', 'important');
      inner.style.setProperty(
        'animation',
        'footprints-replay-trail-fade 0.45s ease-out 1.5s forwards',
        'important',
      );
      wrap.appendChild(inner);
      footprintsLayer.appendChild(wrap);
      const rec = { el: wrap, docX, docY };
      trailFadingPrints.push(rec);
      wrap.style.left = `${docX - window.scrollX}px`;
      wrap.style.top = `${docY - window.scrollY}px`;
      wrap.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg) scale(0.88)`;
      inner.addEventListener(
        'animationend',
        () => {
          const idx = trailFadingPrints.indexOf(rec);
          if (idx >= 0) trailFadingPrints.splice(idx, 1);
          wrap.remove();
          if (trailFadingPrints.length === 0) {
            nudgeLauncherAwayFromReplayGuideIfNeeded();
          }
        },
        { once: true },
      );
    }

    /**
     * Stamp only behind (pastX, pastY) — where the guide already was — never toward (towardX, towardY).
     * @param {boolean} [lite] intro glide: one print per sample so the path does not paint ahead of motion.
     */
    function spawnTrailBehindPastAnchor(pastX, pastY, towardX, towardY, lite) {
      if (!footprintsLayer) return;
      const dx = towardX - pastX;
      const dy = towardY - pastY;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.5) return;
      const ux = dx / dist;
      const uy = dy / dist;
      const rotDeg = (Math.atan2(uy, ux) * 180) / Math.PI + 90;
      const perpx = -uy;
      const perpy = ux;
      const n = lite
        ? 1
        : Math.min(3, Math.max(1, Math.ceil(Math.min(dist, 420) / 130)));
      for (let i = 0; i < n; i++) {
        const back = TRAIL_FEET_BACK_DOC + i * TRAIL_STEP_BACK_DOC;
        const side = i % 2 === 0 ? -1 : 1;
        const px = pastX - ux * back + perpx * side * 4;
        const py = pastY - uy * back + perpy * side * 4;
        spawnSingleFadingTrailPrint(px, py, rotDeg + side * 3);
      }
      pruneTrailIfNeeded();
    }

    function introTrailFrame() {
      if (!replayAlive || !introTrailSampling || introMotionDone) {
        introTrailRaf = 0;
        return;
      }
      const cur = readRabbitAnchorDoc();
      if (introTrailPrevDoc) {
        if (introTrailLastStampDoc == null) {
          introTrailLastStampDoc = { x: introTrailPrevDoc.x, y: introTrailPrevDoc.y };
        }
        const sdx = cur.x - introTrailLastStampDoc.x;
        const sdy = cur.y - introTrailLastStampDoc.y;
        const gapSq = INTRO_TRAIL_MIN_STAMP_GAP_DOC * INTRO_TRAIL_MIN_STAMP_GAP_DOC;
        if (sdx * sdx + sdy * sdy >= gapSq) {
          spawnTrailBehindPastAnchor(
            introTrailLastStampDoc.x,
            introTrailLastStampDoc.y,
            cur.x,
            cur.y,
            true,
          );
          introTrailLastStampDoc = { x: cur.x, y: cur.y };
        }
      }
      introTrailPrevDoc = cur;
      introTrailRaf = window.requestAnimationFrame(introTrailFrame);
    }

    function scrollMaxesFp() {
      const se = document.scrollingElement || document.documentElement;
      const bw = document.body ? document.body.scrollWidth : 0;
      const bh = document.body ? document.body.scrollHeight : 0;
      const sx = Math.max(se.scrollWidth, document.documentElement.scrollWidth, bw);
      const sy = Math.max(se.scrollHeight, document.documentElement.scrollHeight, bh);
      return {
        maxX: Math.max(0, sx - window.innerWidth),
        maxY: Math.max(0, sy - window.innerHeight),
      };
    }
    function clampFp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    }
    function clampDocPointToPage(docX, docY) {
      const { maxX, maxY } = scrollMaxesFp();
      const pageW = maxX + Math.max(1, window.innerWidth);
      const pageH = maxY + Math.max(1, window.innerHeight);
      const pad = MASCOT_VPAD.edgePad;
      const minX = pad + MASCOT_VPAD.halfW;
      const maxDocX = pageW - pad - MASCOT_VPAD.halfW;
      // Anchor is at the mascot feet; account for upward lift so the body does not render above page top.
      const minY = pad + MASCOT_VPAD.liftPx + MASCOT_VPAD.halfH;
      const bottomExtent = Math.max(0, MASCOT_VPAD.halfH - MASCOT_VPAD.liftPx);
      const maxDocY = pageH - pad - bottomExtent;
      return {
        x: clampFp(docX, minX, Math.max(minX, maxDocX)),
        y: clampFp(docY, minY, Math.max(minY, maxDocY)),
      };
    }

    /** Viewport padding; must match .footprints-rabbit-wrap translateY(-52px) and half size ~38px */
    const MASCOT_VPAD = {
      halfW: 42,
      halfH: 42,
      liftPx: 52,
      edgePad: 20,
    };

    /**
     * After scrolling to (sx,sy), path anchor (docX,docY) appears at (ax,ay).
     * Adjust scroll so the lifted mascot’s bounding box stays inside the viewport.
     */
    function clampScrollKeepingMascotVisible(sx, sy, docX, docY) {
      const { maxX, maxY } = scrollMaxesFp();
      /*
       * SPA / nested scrollers often report maxX/maxY === 0 for the window even though inner regions
       * scroll. Never clamp scroll to 0 on those axes — use the current window scroll instead.
       */
      let nsx = maxX > 0 ? clampFp(sx, 0, maxX) : window.scrollX;
      let nsy = maxY > 0 ? clampFp(sy, 0, maxY) : window.scrollY;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const { halfW, halfH, liftPx, edgePad: pad } = MASCOT_VPAD;
      for (let iter = 0; iter < 6; iter++) {
        const ax = docX - nsx;
        const ay = docY - nsy;
        const top = ay - liftPx - halfH;
        const bottom = ay + halfH - liftPx;
        const left = ax - halfW;
        const right = ax + halfW;
        let moved = false;
        if (maxX > 0) {
          if (left < pad) {
            nsx -= pad - left;
            moved = true;
          }
          if (right > W - pad) {
            nsx += right - (W - pad);
            moved = true;
          }
          nsx = clampFp(nsx, 0, maxX);
        }
        if (maxY > 0) {
          if (top < pad) {
            nsy -= pad - top;
            moved = true;
          }
          if (bottom > H - pad) {
            nsy += bottom - (H - pad);
            moved = true;
          }
          nsy = clampFp(nsy, 0, maxY);
        }
        if (!moved) break;
      }
      return { x: nsx, y: nsy };
    }

    function syncAllReplayAnchors() {
      syncTrailFadingPrintsForScroll();
    }

    function onReplayScroll() {
      const fab = document.getElementById(FLOATING_BUNNY_ID);
      if (fab) {
        fab.classList.remove('fp-chew-active');
        clearFloatingChewIdleTimer();
        syncRaccoonLauncherScrollChewVideo(false);
        syncBunnyLauncherScrollChewVideo(false);
        syncFoxLauncherScrollChewVideo(false);
        syncOwlLauncherScrollChewVideo(false);
      }
      syncAllReplayAnchors();
      syncReplayTargetFillBox();
    }
    window.addEventListener('scroll', onReplayScroll, { passive: true });
    function onReplayResize() {
      syncAllReplayAnchors();
      syncReplayTargetFillBox();
    }
    window.addEventListener('resize', onReplayResize, { passive: true });

    /** Place (docX, docY) near this viewport anchor fraction (0–0.5 from left/top). */
    function scrollIdealForDocPoint(docX, docY) {
      const padX = window.innerWidth * 0.36;
      const padY = window.innerHeight * 0.38;
      const { maxX, maxY } = scrollMaxesFp();
      return {
        x: clampFp(docX - padX, 0, maxX),
        y: clampFp(docY - padY, 0, maxY),
      };
    }

    function scrollSnapDocPoint(docX, docY) {
      const { maxX, maxY } = scrollMaxesFp();
      const g = scrollIdealForDocPoint(docX, docY);
      const c = clampScrollKeepingMascotVisible(g.x, g.y, docX, docY);
      const nx = maxX > 0 ? c.x : window.scrollX;
      const ny = maxY > 0 ? c.y : window.scrollY;
      if (nx !== window.scrollX || ny !== window.scrollY) {
        window.scrollTo(nx, ny);
      }
    }

    function scrollDocIntoViewInitial(docX, docY) {
      scrollSnapDocPoint(docX, docY);
    }

    function moveRabbitTo(px, py) {
      rabbitWrap.style.left = `${px}px`;
      rabbitWrap.style.top = `${py}px`;
    }

    function nudgeLauncherAwayFromReplayGuideIfNeeded() {
      const host = document.getElementById(FLOATING_BUNNY_ID);
      if (!host || !document.contains(host) || !document.contains(rabbitWrap)) return;
      const curLeft = parseFloat(host.style.left);
      const curTop = parseFloat(host.style.top);
      if (!Number.isFinite(curLeft) || !Number.isFinite(curTop)) return;
      const { w, h } = floatingFabHostBoxPx(host);
      const hr = host.getBoundingClientRect();
      const gr = rabbitWrap.getBoundingClientRect();
      if (hr.width < 2 || hr.height < 2 || gr.width < 2 || gr.height < 2) return;

      /* Keep Done clickable, but only move for it after trail prints have faded out. */
      const doneNudgeAllowed =
        introMotionDone && (!trailFadingPrints || trailFadingPrints.length === 0);
      if (doneNudgeAllowed && dismiss && document.contains(dismiss)) {
        const dr = dismiss.getBoundingClientRect();
        if (dr.width > 2 && dr.height > 2) {
          const hitDone =
            Math.min(hr.right, dr.right + 8) > Math.max(hr.left, dr.left - 8) &&
            Math.min(hr.bottom, dr.bottom + 8) > Math.max(hr.top, dr.top - 8);
          if (hitDone) {
            const pushDown = Math.max(12, dr.bottom - hr.top + 10);
            const nudged = clampFabToViewport(curLeft, curTop + pushDown, w, h);
            host.style.setProperty('left', `${nudged.left}px`, 'important');
            host.style.setProperty('top', `${nudged.top}px`, 'important');
            return;
          }
        }
      }

      const pad = 12;
      const ix =
        Math.min(hr.right, gr.right + pad) - Math.max(hr.left, gr.left - pad);
      const iy =
        Math.min(hr.bottom, gr.bottom + pad) - Math.max(hr.top, gr.top - pad);
      if (ix <= 0 || iy <= 0) return;
      const hcX = hr.left + hr.width / 2;
      const hcY = hr.top + hr.height / 2;
      const gcX = gr.left + gr.width / 2;
      const gcY = gr.top + gr.height / 2;
      let vx = hcX - gcX;
      let vy = hcY - gcY;
      const len = Math.hypot(vx, vy) || 1;
      vx /= len;
      vy /= len;
      const push = Math.max(ix, iy) + 10;
      const next = clampFabToViewport(curLeft + vx * push, curTop + vy * push, w, h);
      if (Math.hypot(next.left - curLeft, next.top - curTop) < 0.75) return;
      host.style.setProperty('left', `${next.left}px`, 'important');
      host.style.setProperty('top', `${next.top}px`, 'important');
    }

    /**
     * When the waypoint is in the top band (nav / header), keep the lifted mascot on-screen
     * by anchoring below the control if we can resolve it, else nudge down in doc space.
     */
    function displayDocForBunny(rabbitDocX, rabbitDocY, action) {
      const topBand = Math.min(152, window.innerHeight * 0.24);
      const gapBelowCtl = 30;
      let x = rabbitDocX;
      let y = rabbitDocY;

      if (action && action.descriptor) {
        const el = U.resolveElement(action.descriptor);
        if (el && document.contains(el)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) {
            if (r.top < topBand) {
              x = window.scrollX + r.left + r.width / 2;
              y = window.scrollY + r.bottom + gapBelowCtl;
              return clampDocPointToPage(x, y);
            }
          }
        }
      }

      const vpY = rabbitDocY - window.scrollY;
      const minVpY =
        MASCOT_VPAD.edgePad + MASCOT_VPAD.liftPx + MASCOT_VPAD.halfH + 6;
      if (vpY < minVpY) {
        y = rabbitDocY + (minVpY - vpY);
      }
      return clampDocPointToPage(x, y);
    }

    function positionBunnyDoc(rabbitDocX, rabbitDocY, act) {
      if (act) setReplayTargetGlowForAction(act);
      const d = displayDocForBunny(rabbitDocX, rabbitDocY, act);
      lastReplayGuideDocPoint = {
        x: d.x,
        y: d.y,
        pageNorm: U.canonicalPageKey(location.href),
      };
      if (trailLastPositionedDoc) {
        spawnTrailBehindPastAnchor(trailLastPositionedDoc.x, trailLastPositionedDoc.y, d.x, d.y, false);
      }
      trailLastPositionedDoc = { x: d.x, y: d.y };
      moveRabbitTo(d.x - window.scrollX, d.y - window.scrollY);
      nudgeLauncherAwayFromReplayGuideIfNeeded();
    }

    let introMotionFailSafe = 0;
    let stopManualSamePageIntro = null;

    scrollReplayAnchorIntoViewBeforeDocPoint(action);
    const docPt = U.resolveReplayDocPoint(action);

    /* Glide from launcher → step for every mascot (compact + full retrace). */
    {
      const fab = document.getElementById(FLOATING_BUNNY_ID);
      let startDoc = { x: docPt.x, y: docPt.y };
      /** Match replay sprite to the visible launcher PNG (not the 64px button / 76px guide box). */
      let fabMascotIconRect = null;
      let startFromLastRetrace = false;
      const hereNorm = U.canonicalPageKey(location.href);
      let crossPageEntry =
        entryHintFromReplaySession === 'fromRight' || entryHintFromReplaySession === 'fromLeft'
          ? entryHintFromReplaySession
          : null;
      if (!crossPageEntry) {
        try {
          const raw = sessionStorage.getItem(REPLAY_CROSS_PAGE_ENTRY_SS_KEY);
          if (raw === 'fromRight' || raw === 'fromLeft') {
            sessionStorage.removeItem(REPLAY_CROSS_PAGE_ENTRY_SS_KEY);
            crossPageEntry = raw;
          }
        } catch (e) {
          /* ignore */
        }
      }
      /* Entry glide after cross-page nav (see REPLAY_CROSS_PAGE_ENTRY_SS_KEY comment). */
      if (crossPageEntry === 'fromRight') {
        /* User used left arrow on previous page: mascot re-enters from past the right edge. */
        startDoc = { x: window.scrollX + window.innerWidth + 140, y: docPt.y };
        startFromLastRetrace = true;
        fabMascotIconRect = null;
      } else if (crossPageEntry === 'fromLeft') {
        /* User used right arrow on previous page: re-enter from past the left edge. */
        startDoc = { x: window.scrollX - window.innerWidth - 140, y: docPt.y };
        startFromLastRetrace = true;
        fabMascotIconRect = null;
      } else if (
        lastReplayGuideDocPoint &&
        lastReplayGuideDocPoint.pageNorm === hereNorm &&
        Number.isFinite(lastReplayGuideDocPoint.x) &&
        Number.isFinite(lastReplayGuideDocPoint.y)
      ) {
        const clampedStart = clampDocPointToPage(lastReplayGuideDocPoint.x, lastReplayGuideDocPoint.y);
        startDoc = { x: clampedStart.x, y: clampedStart.y };
        startFromLastRetrace = true;
      }
      if (!startFromLastRetrace && fab) {
        const iconEl = fab.querySelector('.footprints-floating-bunny-img');
        let iconRectForStart = null;
        if (iconEl) {
          const ir = iconEl.getBoundingClientRect();
          if (
            ir.width > 2 &&
            ir.height > 2 &&
            ir.width <= REPLAY_LAUNCHER_ICON_RECT_MAX_EDGE_PX &&
            ir.height <= REPLAY_LAUNCHER_ICON_RECT_MAX_EDGE_PX
          ) {
            fabMascotIconRect = ir;
            iconRectForStart = ir;
          }
        }
        if (iconRectForStart) {
          /* Anchor to the visible launcher PNG (matches `applyFabMascotMatchFromRect` sizing), not the outer button. */
          startDoc = {
            x: window.scrollX + iconRectForStart.left + iconRectForStart.width / 2,
            y: window.scrollY + iconRectForStart.top + iconRectForStart.height / 2,
          };
        } else {
          const circleEl = fab.querySelector('button');
          const rBtn = (circleEl || fab).getBoundingClientRect();
          if (rBtn.width > 2 && rBtn.height > 2) {
            startDoc = {
              x: window.scrollX + rBtn.left + rBtn.width / 2,
              y: window.scrollY + rBtn.top + rBtn.height / 2,
            };
          }
        }
      }

      const useManualIntroScroll = !crossPageEntry;
      if (!useManualIntroScroll) {
        scrollDocIntoViewInitial(docPt.x, docPt.y);
      } else if (startFromLastRetrace) {
        // For same-page hops, first center the previous point so users can see where the guide leaves from.
        scrollSnapDocPoint(startDoc.x, startDoc.y);
      }
      const clampedDocPt = clampDocPointToPage(docPt.x, docPt.y);
      const endDoc = displayDocForBunny(clampedDocPt.x, clampedDocPt.y, action);
      const endVp = { x: endDoc.x - window.scrollX, y: endDoc.y - window.scrollY };

      const replayMascot = createRabbitHopMascot({
        retraceTrip: { fromDoc: startDoc, toDoc: endDoc },
      });
      applyRetraceMascotGlow(replayMascot);
      rabbitWrap.appendChild(replayMascot);

      const introMs = REPLAY_INTRO_GLIDE_MS;
      if (
        replayMascot.tagName === 'VIDEO' ||
        isRaccoonRetraceWalkStack(replayMascot) ||
        isBunnyRetraceWalkStack(replayMascot) ||
        isFoxRetraceWalkStack(replayMascot)
      ) {
        syncRaccoonRetraceWalkClipToGlideDuration(replayMascot, introMs);
      }

      /* As soon as the glide start is known — before intro finishes — so cross-page arrows still get a valid exit anchor if the user advances early. */
      lastReplayGuideDocPoint = {
        x: startDoc.x,
        y: startDoc.y,
        pageNorm: hereNorm,
      };

      function clearReplayMascotFabMatchStyles() {
        rabbitWrap.style.removeProperty('width');
        rabbitWrap.style.removeProperty('height');
        rabbitWrap.style.removeProperty('margin-left');
        rabbitWrap.style.removeProperty('margin-top');
        rabbitWrap.style.removeProperty('transform');
        rabbitWrap.querySelectorAll('.footprints-rabbit-mascot').forEach((mi) => {
          mi.style.removeProperty('object-position');
          mi.style.removeProperty('object-fit');
        });
      }

      function applyFabMascotMatchFromRect(ir) {
        const s = REPLAY_INTRO_FROM_LAUNCHER_MASCOT_SCALE;
        let w = ir.width * s;
        let h = ir.height * s;
        const maxEdge = REPLAY_GUIDE_BOX_MAX_EDGE_PX;
        if (w > maxEdge || h > maxEdge) {
          const k = Math.min(maxEdge / w, maxEdge / h, 1);
          w *= k;
          h *= k;
        }
        rabbitWrap.style.setProperty('width', `${w}px`, 'important');
        rabbitWrap.style.setProperty('height', `${h}px`, 'important');
        rabbitWrap.style.setProperty('margin-left', `${-w / 2}px`, 'important');
        rabbitWrap.style.setProperty('margin-top', `${-h / 2}px`, 'important');
        /* Keep overlay “feet” lift (default -52px at 76px box); `none` made the guide miss the launcher. */
        const baseGuideH = 76;
        const baseLiftPx = 52;
        let liftPx = Math.round((baseLiftPx * h) / baseGuideH);
        if (cachedMascotId === 'fox') {
          liftPx += FP_FOX_RETRACE_INTRO_EXTRA_LIFT_PX;
        }
        rabbitWrap.style.setProperty('transform', `translateY(-${liftPx}px)`, 'important');
        /* Raccoon walk stack: two canvases share `.footprints-rabbit-mascot` — both must match FAB (querySelector only hit the first). */
        rabbitWrap.querySelectorAll('.footprints-rabbit-mascot').forEach((mi) => {
          mi.style.setProperty('object-fit', 'contain', 'important');
          mi.style.setProperty('object-position', 'center bottom', 'important');
        });
      }

      const introScrollStart = { x: window.scrollX, y: window.scrollY };
      let introScrollEnd = introScrollStart;
      if (useManualIntroScroll) {
        const g = scrollIdealForDocPoint(endDoc.x, endDoc.y);
        introScrollEnd = clampScrollKeepingMascotVisible(g.x, g.y, endDoc.x, endDoc.y);
      }
      const startVp = { x: startDoc.x - introScrollStart.x, y: startDoc.y - introScrollStart.y };
      rabbitWrap.style.transition = 'none';
      if (!startFromLastRetrace && fabMascotIconRect) {
        applyFabMascotMatchFromRect(fabMascotIconRect);
      } else {
        clearReplayMascotFabMatchStyles();
      }
      moveRabbitTo(startVp.x, startVp.y);
      void rabbitWrap.offsetHeight;
      introMotionDone = false;
      introTrailPrevDoc = readRabbitAnchorDoc();
      introTrailLastStampDoc = null;
      /* First glide from launcher: trail sampling must match startDoc (FAB feet), not a rounded getComputedStyle delta. */
      if (!startFromLastRetrace && fab) {
        introTrailPrevDoc = { x: startDoc.x, y: startDoc.y };
        introTrailLastStampDoc = { x: startDoc.x, y: startDoc.y };
      }
      let manualIntroRaf = 0;
      function introEase(t) {
        return Math.max(0, Math.min(1, t));
      }
      function stopManualIntro() {
        if (manualIntroRaf) {
          cancelAnimationFrame(manualIntroRaf);
          manualIntroRaf = 0;
        }
      }
      stopManualSamePageIntro = stopManualIntro;
      function startManualSamePageIntro() {
        const fromDoc = { x: startDoc.x, y: startDoc.y };
        const toDoc = { x: endDoc.x, y: endDoc.y };
        let startTs = 0;
        function frame(ts) {
          if (introMotionDone) {
            manualIntroRaf = 0;
            return;
          }
          if (!startTs) startTs = ts;
          const p = Math.max(0, Math.min(1, (ts - startTs) / introMs));
          const e = introEase(p);
          const sm = scrollMaxesFp();
          let sx = introScrollStart.x + (introScrollEnd.x - introScrollStart.x) * e;
          let sy = introScrollStart.y + (introScrollEnd.y - introScrollStart.y) * e;
          if (sm.maxX <= 0) sx = window.scrollX;
          if (sm.maxY <= 0) sy = window.scrollY;
          window.scrollTo(sx, sy);
          const dx = fromDoc.x + (toDoc.x - fromDoc.x) * e;
          const dy = fromDoc.y + (toDoc.y - fromDoc.y) * e;
          moveRabbitTo(dx - sx, dy - sy);
          if (p >= 1) {
            manualIntroRaf = 0;
            finishIntroMotion();
            return;
          }
          manualIntroRaf = window.requestAnimationFrame(frame);
        }
        manualIntroRaf = window.requestAnimationFrame(frame);
      }
      function settleReplayMascotToStaticImage() {
        if (
          !replayMascot ||
          !rabbitWrap ||
          !rabbitWrap.isConnected ||
          replayMascot.getAttribute('data-fp-settled-static') === '1'
        ) {
          return;
        }
        const isMovingVideo =
          replayMascot.tagName === 'VIDEO' ||
          isRaccoonRetraceWalkStack(replayMascot) ||
          isBunnyRetraceWalkStack(replayMascot) ||
          isFoxRetraceWalkStack(replayMascot);
        if (!isMovingVideo) return;
        replayMascot.setAttribute('data-fp-settled-static', '1');

        const animal = getFootprintsAnimal(cachedMascotId);
        const staticImg = document.createElement('img');
        staticImg.className = 'footprints-rabbit-mascot';
        staticImg.src = cachedMascotUrl;
        staticImg.alt = animal.label + ' guide';
        staticImg.draggable = false;
        staticImg.decoding = 'async';
        applyRetraceMascotGlow(staticImg);
        let swapped = false;
        function runSwap() {
          if (swapped || !rabbitWrap.isConnected) return;
          swapped = true;
          disposeFootprintsWalkMatteDecoders(replayMascot);
          replayMascot.replaceWith(staticImg);
        }

        // Avoid flash: only fade when the static image is actually ready to paint.
        if (staticImg.complete) {
          runSwap();
          return;
        }
        if (typeof staticImg.decode === 'function') {
          staticImg.decode().then(runSwap, runSwap);
        } else {
          staticImg.addEventListener('load', runSwap, { once: true });
          staticImg.addEventListener('error', runSwap, { once: true });
          window.setTimeout(runSwap, 220);
        }
      }
      function finishIntroMotion() {
        if (introMotionDone) return;
        introMotionDone = true;
        stopIntroTrailLoop();
        stopManualIntro();
        if (introMotionFailSafe) {
          window.clearTimeout(introMotionFailSafe);
          introMotionFailSafe = 0;
        }
        rabbitWrap.removeEventListener('transitionend', onIntroTransEnd);
        rabbitWrap.style.transition = 'none';
        trailLastPositionedDoc = readRabbitAnchorDoc();
        positionBunnyDoc(endDoc.x, endDoc.y, action);
        pauseRaccoonRetraceWalkVideos(replayMascot);
        settleReplayMascotToStaticImage();
      }
      function onIntroTransEnd(ev) {
        if (ev.target !== rabbitWrap) return;
        if (ev.propertyName !== 'left' && ev.propertyName !== 'top') return;
        finishIntroMotion();
      }
      rabbitWrap.addEventListener('transitionend', onIntroTransEnd);
      introMotionFailSafe = window.setTimeout(finishIntroMotion, introMs + 420);
      /* Two frames so the start position is painted before end left/top apply — otherwise no transition runs. */
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!replayAlive) return;
          if (isRaccoonRetraceWalkStack(replayMascot)) {
            const layers = replayMascot.querySelectorAll(':scope > .fp-raccoon-walk-ping-layer');
            const va = layers[0] && fpRaccoonWalkLayerDecoderVideo(layers[0]);
            const vb = layers[1] && fpRaccoonWalkLayerDecoderVideo(layers[1]);
            if (va) va.currentTime = 0;
            if (vb) {
              vb.currentTime = REPLAY_RACCOON_WALK_SOFT_HEAD_SEC;
              vb.pause();
            }
            if (va) {
              const pr = va.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          } else if (isBunnyRetraceWalkStack(replayMascot)) {
            const walkVid = fpFirstWalkMatteVideo(replayMascot, 'video.fp-bunny-walk-matte-src');
            if (walkVid) {
              walkVid.currentTime = 0;
              const pr = walkVid.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          } else if (isFoxRetraceWalkStack(replayMascot)) {
            const walkVid = fpFirstWalkMatteVideo(replayMascot, 'video.fp-fox-walk-matte-src');
            if (walkVid) {
              walkVid.currentTime = 0;
              const pr = walkVid.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          } else {
            const walkVid = rabbitWrap.querySelector(
              'video.footprints-raccoon-retrace-video, video.footprints-bunny-retrace-video, video.footprints-fox-retrace-video'
            );
            if (walkVid) {
              walkVid.currentTime = 0;
              const pr = walkVid.play();
              if (pr && typeof pr.catch === 'function') pr.catch(() => {});
            }
          }
          introTrailSampling = true;
          introTrailRaf = window.requestAnimationFrame(introTrailFrame);
          if (useManualIntroScroll) {
            rabbitWrap.style.transition = 'none';
            startManualSamePageIntro();
            return;
          }
          rabbitWrap.style.transition = `left ${introMs}ms linear, top ${introMs}ms linear`;
          moveRabbitTo(endVp.x, endVp.y);
        });
      });
      registerReplayOverlayCleanup((urgent) => {
        stopIntroTrailLoop();
        if (
          replayMascot &&
          (isBunnyRetraceWalkStack(replayMascot) ||
            isFoxRetraceWalkStack(replayMascot) ||
            isRaccoonRetraceWalkStack(replayMascot))
        ) {
          pauseRaccoonRetraceWalkVideos(replayMascot);
          disposeFootprintsWalkMatteDecoders(replayMascot);
        }
        if (typeof stopManualSamePageIntro === 'function') {
          stopManualSamePageIntro();
          stopManualSamePageIntro = null;
        }
        replayAlive = false;
        if (introMotionFailSafe) {
          window.clearTimeout(introMotionFailSafe);
          introMotionFailSafe = 0;
        }
        clearReplayTargetGlow();
        window.removeEventListener('scroll', onReplayScroll);
        window.removeEventListener('resize', onReplayResize);
        document.removeEventListener('pointerdown', onDocumentPointerDownStopReplay, true);
        document.removeEventListener('keydown', onReplayStepArrowKeydown, true);
        document.getElementById(REPLAY_EXIT_SLIDE_LAYER_ID)?.remove();
        const el = document.getElementById('footprints-overlay-root');
        if (urgent) {
          document.getElementById(REPLAY_GUIDE_LAYER_ID)?.remove();
          if (el) el.remove();
        } else if (el) {
          el.classList.add('footprints-dismissed');
          setTimeout(() => {
            el.remove();
            document.getElementById(REPLAY_GUIDE_LAYER_ID)?.remove();
          }, 400);
        } else {
          document.getElementById(REPLAY_GUIDE_LAYER_ID)?.remove();
        }
      });
    }

    function userAbortReplay() {
      replayAlive = false;
      const m = multiPageReplay;
      const replayRunIdAtStop =
        m && Number.isFinite(m.replayRunId) ? m.replayRunId : replayRunId;
      const viewedLastStep =
        m && m.actions.length > 0 && m.index >= m.actions.length - 1;
      if (viewedLastStep) {
        stopActiveFootprintsReplay = null;
        finishMultiPageReplay();
        return;
      }
      const hereNorm = U.canonicalPageKey(location.href);
      const leaveReplayPage =
        m &&
        !m.stayOnPage &&
        shouldNavigateToReplayStartUrl(m.originNorm, m.originHref, hereNorm);
      const originHref = leaveReplayPage ? m.originHref : '';
      const preFab = leaveReplayPage ? m.preReplayFabPos : null;
      const pinFab =
        m &&
        m.preReplayFabPos &&
        Number.isFinite(m.preReplayFabPos.left) &&
        Number.isFinite(m.preReplayFabPos.top)
          ? { left: m.preReplayFabPos.left, top: m.preReplayFabPos.top }
          : null;
      teardownReplayUi();
      if (leaveReplayPage) {
        abortMultiPageReplay(() => {
          if (!cachedShowFloatingWidget) {
            removeFloatingLauncherDom();
          }
          navigateToReplayStartUrl(originHref, preFab);
        }, replayRunIdAtStop);
        return;
      }
      abortMultiPageReplay(undefined, replayRunIdAtStop);
      restoreLauncherAfterReplayStop(pinFab);
    }

    stopActiveFootprintsReplay = userAbortReplay;
    document.addEventListener('pointerdown', onDocumentPointerDownStopReplay, true);
    document.addEventListener('keydown', onReplayStepArrowKeydown, true);

    dismiss.addEventListener('click', () => invokeStopActiveFootprintsReplay());
    if (!compact) {
      scrim.addEventListener('click', () => invokeStopActiveFootprintsReplay());
    }
  }

  function normalizeHrefForPage(href) {
    if (!href) return '';
    try {
      return new URL(href, location.href).href;
    } catch (e) {
      return href;
    }
  }

  /**
   * Best anchor element for opener hint: match stored linkHref (canonical URL), then closest in document space to the click.
   */
  function resolveHintLinkElement(anchor) {
    if (!anchor) return null;
    const wantRaw = anchor.linkHref ? normalizeHrefForPage(anchor.linkHref) : '';
    const wantKey = wantRaw ? U.canonicalPageKey(wantRaw) : '';
    const locator = anchor.linkLocator || null;
    /* Document-space click point — anchor stores clientX/Y + scroll at click (≈ pageX/pageY). */
    const docCx =
      anchor.x != null ? (anchor.x || 0) + (anchor.scrollX || 0) : null;
    const docCy =
      anchor.y != null ? (anchor.y || 0) + (anchor.scrollY || 0) : null;
    const wantDesc = anchor.descriptor || null;
    function normText(s) {
      return String(s || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
    }
    function linkHrefKey(el) {
      try {
        return U.canonicalPageKey(new URL(el.href, location.href).href);
      } catch (e) {
        return '';
      }
    }
    if (locator && locator.cssPath) {
      try {
        const byPath = document.querySelector(locator.cssPath);
        if (byPath && byPath.tagName === 'A' && byPath.getAttribute('href')) {
          const pathKey = linkHrefKey(byPath);
          if (!wantKey || !pathKey || pathKey === wantKey) {
            return byPath;
          }
        }
      } catch (e) {
        /* invalid selector on dynamic pages; ignore */
      }
    }
    if (wantKey || wantDesc) {
      const links = document.querySelectorAll('a[href]');
      if (wantKey && locator && Number.isInteger(locator.sameHrefIndex)) {
        const sameHref = [];
        for (let i = 0; i < links.length; i++) {
          if (linkHrefKey(links[i]) === wantKey) sameHref.push(links[i]);
        }
        if (sameHref.length) {
          const idx = Math.max(0, Math.min(sameHref.length - 1, locator.sameHrefIndex));
          const byOrdinal = sameHref[idx];
          if (byOrdinal) return byOrdinal;
        }
      }
      let best = null;
      let bestScore = -Infinity;
      let bestDist = Infinity;
      for (let i = 0; i < links.length; i++) {
        const linkEl = links[i];
        const hKey = linkHrefKey(linkEl);
        let hRaw = '';
        try {
          hRaw = normalizeHrefForPage(linkEl.href || '');
        } catch (e) {
          hRaw = '';
        }
        const r = linkEl.getBoundingClientRect();
        const hasBox = r.width > 0 && r.height > 0;
        let score = 0;

        if (wantRaw) {
          if (hRaw && hRaw === wantRaw) score += 5000;
          else if (hKey && hKey === wantKey) score += 2400;
          else score -= 1200;
        }

        if (wantDesc) {
          if (wantDesc.id && linkEl.id === wantDesc.id) score += 2000;
          if (wantDesc.classes) {
            const wantClasses = String(wantDesc.classes)
              .split(/\s+/)
              .filter(Boolean);
            let overlap = 0;
            for (let c = 0; c < wantClasses.length; c++) {
              if (linkEl.classList.contains(wantClasses[c])) overlap++;
            }
            score += overlap * 220;
          }
          if (wantDesc.textSnippet) {
            const wantText = normText(wantDesc.textSnippet);
            const gotText = normText(linkEl.innerText || linkEl.textContent || '');
            if (wantText && gotText) {
              if (gotText === wantText) score += 1800;
              else if (gotText.includes(wantText) || wantText.includes(gotText)) score += 700;
            }
          }
        }

        if (locator) {
          if (locator.title) {
            const gotTitle = normText(linkEl.getAttribute('title') || '');
            if (gotTitle && gotTitle === normText(locator.title)) score += 550;
          }
          if (locator.ariaLabel) {
            const gotAria = normText(linkEl.getAttribute('aria-label') || '');
            if (gotAria && gotAria === normText(locator.ariaLabel)) score += 550;
          }
          if (locator.text) {
            const gotText2 = normText(linkEl.innerText || linkEl.textContent || '');
            const wantText2 = normText(locator.text);
            if (gotText2 && wantText2) {
              if (gotText2 === wantText2) score += 1200;
              else if (gotText2.includes(wantText2) || wantText2.includes(gotText2)) score += 420;
            }
          }
        }

        if (hasBox) {
          score += 180;
        } else {
          score -= 800;
        }

        let dist = Infinity;
        if (docCx != null && docCy != null && hasBox) {
          const mx = r.left + r.width / 2 + window.scrollX;
          const my = r.top + r.height / 2 + window.scrollY;
          dist = (mx - docCx) * (mx - docCx) + (my - docCy) * (my - docCy);
          if (dist <= 1600) score += 1600;
          else if (dist <= 10000) score += 950;
          else if (dist <= 40000) score += 450;
          else if (dist <= 160000) score += 170;
        }

        if (score > bestScore || (score === bestScore && dist < bestDist)) {
          bestScore = score;
          bestDist = dist;
          best = linkEl;
        }
      }
      if (best && bestScore >= 800) return best;
    }
    if (anchor.descriptor) {
      const el = U.resolveElement(anchor.descriptor);
      if (el && document.contains(el)) {
        if (el.tagName === 'A' && el.getAttribute('href')) return el;
        const innerA = el.closest && el.closest('a[href]');
        if (innerA && document.contains(innerA)) return innerA;
        return el;
      }
    }
    return null;
  }

  function docPointFromStoredAnchor(anchor) {
    if (!anchor) {
      return {
        x: window.scrollX + window.innerWidth / 2,
        y: window.scrollY + window.innerHeight / 2,
      };
    }
    const linkEl = resolveHintLinkElement(anchor);
    if (linkEl) {
      const r = linkEl.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        return {
          x: r.left + r.width / 2 + window.scrollX,
          y: r.top + r.height / 2 + window.scrollY,
        };
      }
    }
    return {
      x: (anchor.x || 0) + (anchor.scrollX || 0),
      y: (anchor.y || 0) + (anchor.scrollY || 0),
    };
  }

  /** Document-space point for the hint rabbit: beside the link (not centered on it). */
  function bunnyDocPointBesideHintLink(anchor) {
    const fallback = docPointFromStoredAnchor(anchor);
    const linkEl = resolveHintLinkElement(anchor);
    if (!linkEl || !document.contains(linkEl)) return fallback;
    const r = linkEl.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return fallback;
    const gap = 52;
    const rabbitHalf = 40;
    const minDocX = window.scrollX + 24;
    const maxDocX = window.scrollX + window.innerWidth - 24;
    let docX = window.scrollX + r.left - gap - rabbitHalf;
    const docY = window.scrollY + r.top + r.height / 2;
    if (docX < minDocX + rabbitHalf) {
      docX = window.scrollX + r.right + gap + rabbitHalf;
    }
    if (docX > maxDocX) {
      docX = Math.max(minDocX + rabbitHalf, window.scrollX + r.left - gap - rabbitHalf);
    }
    return { x: docX, y: docY };
  }

  /**
   * Shown on the opener tab after user chooses “Take me to the tab” from the child.
   * @param {object} anchor descriptor + coords from when the link was activated
   */
  function showOpenedLinkHint(anchor) {
    ensureOverlayCss();
    const root = document.createElement('div');
    root.id = 'footprints-link-hint-root';
    root.className = 'footprints-root footprints-interactive';
    root.setAttribute('data-footprints-link-hint', '1');

    const syncStyle = document.createElement('style');
    syncStyle.textContent =
      '#footprints-link-hint-root .footprints-trail-inner{' +
      'opacity:0.95!important;width:17px!important;height:23px!important;' +
      'transform-origin:50% 82%!important;animation:none!important;}' +
      '#footprints-link-hint-root .footprints-trail-inner svg{' +
      'width:100%!important;height:100%!important;display:block!important;object-fit:contain!important;}' +
      '#footprints-link-hint-root .footprints-footprints-layer{' +
      'z-index:22!important;position:absolute!important;inset:0!important;pointer-events:none!important;overflow:visible!important;}' +
      '#footprints-link-hint-root .footprints-rabbit-wrap{' +
      'z-index:24!important;border:none!important;outline:none!important;box-shadow:none!important;background:transparent!important;' +
      'transform:translateY(-52px)!important;}' +
      '#footprints-link-hint-root .footprints-rabbit-mascot{' +
      'filter:drop-shadow(0 2px 8px rgba(0,0,0,0.14)) drop-shadow(0 0 22px rgba(90,195,130,0.52)) drop-shadow(0 0 40px rgba(50,160,88,0.32))!important;' +
      '-webkit-filter:drop-shadow(0 2px 8px rgba(0,0,0,0.14)) drop-shadow(0 0 22px rgba(90,195,130,0.52)) drop-shadow(0 0 40px rgba(50,160,88,0.32))!important;}' +
      '#footprints-link-hint-root .footprints-link-hint-glow{' +
      'position:fixed!important;pointer-events:none!important;z-index:7!important;' +
      'box-sizing:border-box!important;border-radius:8px!important;' +
      'background:rgba(74,180,108,0.38)!important;' +
      'box-shadow:' +
      'inset 0 0 0 2px rgba(74,180,108,0.55),' +
      'inset 0 0 0 9999px rgba(90,195,130,0.12),' +
      '0 0 8px 2px rgba(186,242,208,0.78),' +
      '0 0 18px 5px rgba(74,180,108,0.68),' +
      '0 0 30px 9px rgba(28,120,68,0.52),' +
      '0 0 48px 14px rgba(90,195,125,0.42)!important;}';
    root.appendChild(syncStyle);

    const scrim = document.createElement('div');
    scrim.className = 'footprints-scrim';

    const linkHighlightEl = document.createElement('div');
    linkHighlightEl.className = 'footprints-link-hint-glow';
    linkHighlightEl.setAttribute('aria-hidden', 'true');
    linkHighlightEl.style.display = 'none';

    const footprintsLayer = document.createElement('div');
    footprintsLayer.className = 'footprints-footprints-layer';
    footprintsLayer.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:22;overflow:visible;';

    const label = document.createElement('div');
    label.className = 'footprints-link-hint-label';
    label.textContent = anchor
      ? 'Here’s the link that opened your other tab.'
      : 'Returned to the tab you opened from — we couldn’t lock the exact link, so your guide is centered here.';

    const rabbitWrap = document.createElement('div');
    rabbitWrap.className = 'footprints-rabbit-wrap';
    rabbitWrap.appendChild(createRabbitHopMascot());
    rabbitWrap.style.transition = 'none';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'footprints-dismiss';
    dismiss.textContent = 'Done';

    root.appendChild(scrim);
    root.appendChild(linkHighlightEl);
    root.appendChild(footprintsLayer);
    root.appendChild(label);
    root.appendChild(rabbitWrap);
    root.appendChild(dismiss);

    const tailPrints = [];
    const TAIL_PRINT_COUNT = 3;
    const TAIL_STEP_PX = 24;
    const TAIL_FEET_BACK_PX = 12;
    const TAIL_STAGGER_PX = 4;
    const TAIL_FEET_SHIFT_PX = 8;
    const TAIL_PRINT_NUDGE_DOC_X = -12;
    const TAIL_PRINT_NUDGE_DOC_Y = -24;

    function ensureTailPrints() {
      if (tailPrints.length) return;
      for (let i = 0; i < TAIL_PRINT_COUNT; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'footprints-trail-wrap';
        const inner = document.createElement('div');
        inner.className = 'footprints-trail-inner';
        inner.innerHTML = footprintSvgTrail();
        inner.style.setProperty('opacity', '1', 'important');
        inner.style.setProperty('width', '17px', 'important');
        inner.style.setProperty('height', '23px', 'important');
        inner.style.setProperty('transform-origin', '50% 82%', 'important');
        inner.style.setProperty('animation', 'none', 'important');
        wrap.appendChild(inner);
        footprintsLayer.appendChild(wrap);
        tailPrints.push({ el: wrap, docX: 0, docY: 0 });
      }
    }

    function syncDocAnchored() {
      for (let j = 0; j < tailPrints.length; j++) {
        const o = tailPrints[j];
        o.el.style.left = `${o.docX - window.scrollX}px`;
        o.el.style.top = `${o.docY - window.scrollY}px`;
      }
    }

    function updateTailPrintsBehindBunny(rabbitDocX, rabbitDocY) {
      ensureTailPrints();
      const inv = 1 / Math.SQRT2;
      const lineX = -inv;
      const lineY = -inv;
      const feetX =
        rabbitDocX + TAIL_FEET_SHIFT_PX * inv + TAIL_PRINT_NUDGE_DOC_X;
      const feetY =
        rabbitDocY + TAIL_FEET_SHIFT_PX * inv + TAIL_PRINT_NUDGE_DOC_Y;
      const perpC = -lineY;
      const perpS = lineX;
      const rotDeg = (Math.atan2(-lineY, -lineX) * 180) / Math.PI + 90;
      const tailBackExtraPx =
        cachedMascotId === 'raccoon' ? 16 : cachedMascotId === 'owl' ? 20 : 0;
      const baseX = feetX + lineX * (TAIL_FEET_BACK_PX + tailBackExtraPx);
      const baseY = feetY + lineY * (TAIL_FEET_BACK_PX + tailBackExtraPx);
      for (let k = 0; k < TAIL_PRINT_COUNT; k++) {
        const along = 8 + k * TAIL_STEP_PX;
        const side = k % 2 === 0 ? -1 : 1;
        const px = baseX + lineX * along + perpC * TAIL_STAGGER_PX * side;
        const py = baseY + lineY * along + perpS * TAIL_STAGGER_PX * side;
        const o = tailPrints[k];
        o.docX = px;
        o.docY = py;
        o.el.style.transform = `translate(-50%, -50%) rotate(${rotDeg}deg) scale(0.92)`;
      }
      syncDocAnchored();
    }

    function scrollNearAnchor() {
      const doc = docPointFromStoredAnchor(anchor);
      const padX = window.innerWidth * 0.36;
      const padY = window.innerHeight * 0.38;
      const se = document.scrollingElement || document.documentElement;
      const bw = document.body ? document.body.scrollWidth : 0;
      const bh = document.body ? document.body.scrollHeight : 0;
      const maxX = Math.max(
        0,
        Math.max(se.scrollWidth, document.documentElement.scrollWidth, bw) - window.innerWidth
      );
      const maxY = Math.max(
        0,
        Math.max(se.scrollHeight, document.documentElement.scrollHeight, bh) - window.innerHeight
      );
      const sx = Math.max(0, Math.min(maxX, doc.x - padX));
      const sy = Math.max(0, Math.min(maxY, doc.y - padY));
      window.scrollTo(sx, sy);
    }

    /** Prefer true element scrolling (handles nested overflow containers), then window fallback. */
    function scrollHintTargetIntoView() {
      const linkEl = resolveHintLinkElement(anchor);
      if (linkEl && typeof linkEl.scrollIntoView === 'function') {
        try {
          linkEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          return;
        } catch (e) {
          /* host restrictions; fallback below */
        }
      }
      scrollNearAnchor();
    }

    const scrollHintOpts = { passive: true };
    const resizeHintOpts = { passive: true };

    /** Resolved after layout / scroll — drives highlight box + rabbit. */
    let hintResolvedLink = null;
    let layoutRetryTimer = 0;
    let focusHintTimer = 0;

    function syncLinkHighlightBox() {
      if (!hintResolvedLink || !document.contains(hintResolvedLink)) {
        linkHighlightEl.style.setProperty('display', 'none', 'important');
        return;
      }
      const r = hintResolvedLink.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) {
        linkHighlightEl.style.setProperty('display', 'none', 'important');
        return;
      }
      linkHighlightEl.style.setProperty('display', 'block', 'important');
      linkHighlightEl.style.setProperty('left', `${r.left}px`, 'important');
      linkHighlightEl.style.setProperty('top', `${r.top}px`, 'important');
      linkHighlightEl.style.setProperty('width', `${r.width}px`, 'important');
      linkHighlightEl.style.setProperty('height', `${r.height}px`, 'important');
    }

    function bunnyBesideResolvedLink() {
      const fallback = docPointFromStoredAnchor(anchor);
      const linkEl = hintResolvedLink;
      if (!linkEl || !document.contains(linkEl)) {
        return bunnyDocPointBesideHintLink(anchor);
      }
      const r = linkEl.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return fallback;
      const gap = 52;
      const rabbitHalf = 40;
      const minDocX = window.scrollX + 24;
      const maxDocX = window.scrollX + window.innerWidth - 24;
      let docX = window.scrollX + r.left - gap - rabbitHalf;
      const docY = window.scrollY + r.top + r.height / 2;
      if (docX < minDocX + rabbitHalf) {
        docX = window.scrollX + r.right + gap + rabbitHalf;
      }
      if (docX > maxDocX) {
        docX = Math.max(minDocX + rabbitHalf, window.scrollX + r.left - gap - rabbitHalf);
      }
      return { x: docX, y: docY };
    }

    function refreshHintLayout() {
      hintResolvedLink = resolveHintLinkElement(anchor);
      syncLinkHighlightBox();
      const d = bunnyBesideResolvedLink();
      rabbitWrap.style.left = `${d.x - window.scrollX}px`;
      rabbitWrap.style.top = `${d.y - window.scrollY}px`;
      updateTailPrintsBehindBunny(d.x, d.y);
    }

    function isHintLinkFullyVisible() {
      if (!hintResolvedLink || !document.contains(hintResolvedLink)) return false;
      const r = hintResolvedLink.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const pad = 24;
      return (
        r.left >= pad &&
        r.top >= pad &&
        r.right <= window.innerWidth - pad &&
        r.bottom <= window.innerHeight - pad
      );
    }

    function focusHintTargetUntilVisible(attempt) {
      if (!root.isConnected) return;
      refreshHintLayout();
      if (isHintLinkFullyVisible() || attempt >= 6) return;
      scrollHintTargetIntoView();
      if (focusHintTimer) clearTimeout(focusHintTimer);
      focusHintTimer = setTimeout(() => {
        focusHintTimer = 0;
        focusHintTargetUntilVisible(attempt + 1);
      }, 180 + attempt * 90);
    }

    function onScrollHint() {
      refreshHintLayout();
    }

    function onResizeHint() {
      refreshHintLayout();
    }

    function teardownHint() {
      window.removeEventListener('scroll', onScrollHint, scrollHintOpts);
      window.removeEventListener('resize', onResizeHint, resizeHintOpts);
      if (layoutRetryTimer) clearTimeout(layoutRetryTimer);
      if (focusHintTimer) clearTimeout(focusHintTimer);
      hintResolvedLink = null;
      root.remove();
    }

    dismiss.addEventListener('click', teardownHint);
    scrim.addEventListener('click', teardownHint);

    document.documentElement.appendChild(root);
    focusHintTargetUntilVisible(0);
    function runHintAfterLayout() {
      // Some apps settle async; run one more target-first scroll before final paint.
      focusHintTargetUntilVisible(1);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(runHintAfterLayout);
    });
    layoutRetryTimer = setTimeout(() => {
      layoutRetryTimer = 0;
      refreshHintLayout();
    }, 400);
    window.addEventListener('scroll', onScrollHint, scrollHintOpts);
    window.addEventListener('resize', onResizeHint, resizeHintOpts);

    setTimeout(teardownHint, 12000);
  }

  // ---------------------------------------------------------------------------
  // Extension messages (popup / manual replay)
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'FOOTPRINTS_FLUSH_PENDING') {
      if (clusterFlushTimer) {
        clearTimeout(clusterFlushTimer);
        clusterFlushTimer = null;
      }
      if (pendingCluster && tabForegroundForLogging()) {
        flushCluster(() => sendResponse({ ok: true }));
        return true;
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'FOOTPRINTS_START_REPLAY') {
      if (
        isFootprintsReplayRunning() ||
        multiPageReplay ||
        document.getElementById('footprints-overlay-root')
      ) {
        invokeStopActiveFootprintsReplay();
        sendResponse({ ok: true, stopped: true });
        return false;
      }
      getActionsFromBg((actions) => {
        startReplayFromActions(actions, { compact: msg.compact === true });
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === 'FOOTPRINTS_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'FOOTPRINTS_SHOW_OPENED_LINK_HINT') {
      showOpenedLinkHint(msg.anchor);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function tryConsumePendingReplay() {
    chrome.runtime.sendMessage(
      { type: 'FOOTPRINTS_CONSUME_PENDING_REPLAY', pageUrl: location.href },
      (res) => {
        if (chrome.runtime.lastError) return;
        if (res && res.ok && res.actions && res.actions.length) {
          setTimeout(() => {
            startReplayFromActions(res.actions, { compact: false });
          }, 250);
        }
      }
    );
  }

  /** After replay returns via navigation, restore FAB to where it was before replay (per-tab queue in background). */
  function tryApplyPendingFabRestore() {
    chrome.runtime.sendMessage({ type: 'FOOTPRINTS_POP_PENDING_FAB_RESTORE' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok || !res.pos) return;
      const left = res.pos.left;
      const top = res.pos.top;
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      const size = FLOATING_BUNNY_SIZE_PX;
      const pos = clampFloatingBunny(left, top, size);
      saveFloatingBunnyPos(pos.left, pos.top);
      if (cachedShowFloatingWidget) {
        ensureFloatingBunny();
        const host = document.getElementById(FLOATING_BUNNY_ID);
        if (host) {
          host.style.setProperty('left', `${pos.left}px`, 'important');
          host.style.setProperty('top', `${pos.top}px`, 'important');
        }
        scheduleNudgeFloatingFabIntoViewport();
      }
    });
  }

  function onTabHiddenForLogging() {
    persistFloatingBunnyPosFromDom();
    if (clusterFlushTimer) {
      clearTimeout(clusterFlushTimer);
      clusterFlushTimer = null;
    }
    cancelPauseCheck();
    clearFloatingChewIdleTimer();
    {
      const h = document.getElementById(FLOATING_BUNNY_ID);
      if (h) {
        h.classList.remove('fp-chew-active');
        syncRaccoonLauncherScrollChewVideo(false);
        syncBunnyLauncherScrollChewVideo(false);
        syncFoxLauncherScrollChewVideo(false);
        syncOwlLauncherScrollChewVideo(false);
      }
    }
  }

  function onTabVisibleForLogging() {
    flushPendingClusterNow();
    lastMeaningfulActivity = Date.now();
    scrollBaseline = window.scrollY;
    schedulePauseCheck();
  }

  function init() {
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('auxclick', onAuxClickCapture, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onTabHiddenForLogging);
    window.addEventListener('blur', flushPendingClusterNow);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) onTabHiddenForLogging();
      else onTabVisibleForLogging();
    });
    bumpMeaningfulActivity();
    bootFootprintsFromStorage(() => {
      tryResumeMultiPageReplaySession(() => {
        tryConsumePendingReplay();
        tryShowPendingOpenerGateFromSessionStorage();
        tryApplyPendingFabRestore();
      });
    });
    window.addEventListener('pageshow', (ev) => {
      if (ev.persisted) {
        tryResumeMultiPageReplaySession(() => {
          tryConsumePendingReplay();
          tryShowPendingOpenerGateFromSessionStorage();
          tryApplyPendingFabRestore();
        });
      }
      if (cachedShowFloatingWidget || multiPageReplay) {
        ensureFloatingBunny(multiPageReplay ? { force: true } : undefined);
      }
    });
    reportChildTabReferrerIfNeeded();
    log('content', 'initialized on', location.href);
  }

  /** Lets the background pair this tab to its source when referrer is set (covers context-menu “new tab”). */
  function reportChildTabReferrerIfNeeded() {
    const ref = document.referrer || '';
    if (!ref || !/^https?:\/\//i.test(ref)) return;
    const payload = {
      type: 'FOOTPRINTS_CHILD_TAB_READY',
      pageUrl: location.href,
      referrer: ref,
    };
    const send = () => {
      chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
    };
    send();
    setTimeout(send, 400);
    setTimeout(send, 1200);
  }

  try {
    init();
  } catch (e) {
    warn('init', e);
  }
})();
