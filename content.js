// Content script: keeps every <video> in this frame at the speed chosen in the popup.
//
// The extension is injected into all frames, so each frame only ever touches its own
// documents. That avoids the cross-origin iframe problem the DevTools one-liner has.
//
// The single source of truth is chrome.storage.local, which means:
//   * the popup only has to write the new value, and
//   * every frame in every matching tab picks it up through storage.onChanged.
//
// Storage is also how this script learns that it should stop. Chrome does not unload a
// content script when the host permission it was injected under is revoked: the script
// keeps running, with its listeners attached, until the page navigates. A tab left open
// across a removal would otherwise go on applying the speed to a site the extension is
// no longer allowed to touch, and the popup — which checks the permission properly —
// would correctly show itself as disabled while the page carried on regardless. So the
// service worker publishes the patterns that are currently active, and this script
// shuts itself down when its own frame is no longer covered by them.
(() => {
  const ALREADY_LOADED_FLAG = '__playbackSpeedSliderLoaded';

  // The popup re-injects this file to cover tabs that were already open when the
  // extension was installed or reloaded, so guard against running twice. The flag is
  // claimed at the bottom of this file and only once start() has succeeded, so a frame
  // that failed to start stays eligible for a retry on the next injection. shutDown()
  // gives it back, so a site that is enabled again can be picked up by the next
  // injection without a page reload.
  if (window[ALREADY_LOADED_FLAG]) {
    return;
  }

  const rateApi = globalThis.PlaybackSpeedRate;
  const sitesApi = globalThis.PlaybackSpeedSites;
  if (!rateApi || !sitesApi) {
    // shared/rate.js and shared/sites.js are injected alongside this file; without the
    // first there is no range to clamp against, and without the second no way to tell
    // whether this frame is still covered. Returning without claiming the flag leaves
    // the retry open.
    console.debug('[Playback Speed Slider] shared scripts are missing; not starting.');
    return;
  }
  const { DEFAULT_RATE, normalizeRate } = rateApi;
  const { ACTIVE_KEY, patternCoversHost } = sitesApi;

  const STORAGE_KEY = 'playbackRate';

  // playbackRate round-trips through a double, so compare against it with a tolerance.
  // An exact comparison that never converged would rewrite the rate on every single
  // ratechange event, forever.
  const RATE_EPSILON = 1e-3;

  // A write budget per video. A player that resets playbackRate from its own ratechange
  // handler would otherwise trade events with us at event-loop speed, in every frame at
  // once. Normal operation needs one or two writes per media source swap, so this ceiling
  // is only reachable by something competing for the same property.
  const WRITE_WINDOW_MS = 1000;
  const MAX_WRITES_PER_WINDOW = 20;

  // The site's player resets playbackRate whenever it swaps the media source: starting a
  // title, resuming from an ad break, switching audio track, seeking across a
  // period boundary. Re-apply on all of those.
  const REAPPLY_EVENTS = [
    'ratechange',
    'loadstart',
    'loadedmetadata',
    'canplay',
    'play',
    'playing',
    'seeked',
  ];

  let desiredRate = DEFAULT_RATE;
  let scanScheduled = false;
  // Set when start() rolls itself back, and when this frame stops being covered, so
  // callbacks already in flight become no-ops instead of racing the replacement
  // instance that the next injection creates.
  let disposed = false;
  // The listener attached to each video, kept so it can be taken off again. A WeakMap
  // rather than a list: a video removed from the document should not be held alive by
  // this script.
  const videoHandlers = new WeakMap();
  const writeBudgets = new WeakMap();
  // Everything start() registered, in the order it was registered.
  const undoAll = [];

  /** Takes one write from this video's budget for the current window, if any is left. */
  function claimWrite(video) {
    const now = performance.now();
    let budget = writeBudgets.get(video);
    if (!budget || now - budget.windowStart >= WRITE_WINDOW_MS) {
      budget = { windowStart: now, writes: 0, warned: false };
      writeBudgets.set(video, budget);
    }

    if (budget.writes >= MAX_WRITES_PER_WINDOW) {
      if (!budget.warned) {
        budget.warned = true;
        console.debug(
          '[Playback Speed Slider] write budget for this video is used up for the ' +
            'current second; backing off. Something else is competing for playbackRate.'
        );
      }
      return false;
    }

    budget.writes += 1;
    return true;
  }

  function applyRate(video) {
    if (disposed) {
      return;
    }
    try {
      const rateIsStale = Math.abs(video.playbackRate - desiredRate) > RATE_EPSILON;
      // defaultPlaybackRate makes the rate survive some of the player's own resets.
      const defaultIsStale = Math.abs(video.defaultPlaybackRate - desiredRate) > RATE_EPSILON;

      // Writing the same value would be a no-op, but skipping it also avoids an
      // endless ratechange -> apply -> ratechange loop.
      if (!rateIsStale && !defaultIsStale) {
        return;
      }
      if (!claimWrite(video)) {
        return;
      }

      if (rateIsStale) {
        video.playbackRate = desiredRate;
      }
      if (defaultIsStale) {
        video.defaultPlaybackRate = desiredRate;
      }
    } catch (error) {
      // A detached or not-yet-initialised media element can throw; the next scan or
      // media event will pick it up again. Logged rather than swallowed so that a rate
      // which never applies is distinguishable from one that had nothing to do.
      console.debug('[Playback Speed Slider] could not set the rate on a video:', error);
    }
  }

  function trackVideo(video) {
    if (videoHandlers.has(video)) {
      return;
    }
    const handler = () => applyRate(video);
    videoHandlers.set(video, handler);
    for (const eventName of REAPPLY_EVENTS) {
      video.addEventListener(eventName, handler);
    }
  }

  function untrackVideo(video) {
    const handler = videoHandlers.get(video);
    if (!handler) {
      return;
    }
    for (const eventName of REAPPLY_EVENTS) {
      video.removeEventListener(eventName, handler);
    }
    videoHandlers.delete(video);
  }

  function applyToAllVideos() {
    if (disposed) {
      return;
    }
    for (const video of document.querySelectorAll('video')) {
      trackVideo(video);
      applyRate(video);
    }
  }

  /**
   * Lets go of every video in this frame and puts its speed back to normal.
   *
   * Leaving the last rate in place would strand the user: the popup is disabled on a
   * site the extension may not touch, so there would be no way to put a title that is
   * stuck at 2.5x back to normal short of reloading it. Undoing our own change is also
   * the smallest footprint to leave behind on a page we are no longer allowed to act
   * on.
   */
  function releaseVideos() {
    for (const video of document.querySelectorAll('video')) {
      untrackVideo(video);
      try {
        if (Math.abs(video.playbackRate - DEFAULT_RATE) > RATE_EPSILON) {
          video.playbackRate = DEFAULT_RATE;
        }
        if (Math.abs(video.defaultPlaybackRate - DEFAULT_RATE) > RATE_EPSILON) {
          video.defaultPlaybackRate = DEFAULT_RATE;
        }
      } catch (error) {
        console.debug('[Playback Speed Slider] could not reset a video:', error);
      }
    }
  }

  /** Unregisters everything, in the reverse of the order it was registered. */
  function undoRegistrations() {
    for (const undo of undoAll.reverse()) {
      try {
        undo();
      } catch (undoError) {
        console.debug('[Playback Speed Slider] cleanup failed:', undoError);
      }
    }
    undoAll.length = 0;
  }

  /**
   * Stops for good: no more listeners, no more writes, and the videos handed back.
   *
   * The loaded flag is given up as well, so that enabling the site again and reopening
   * the popup — which re-injects this file — starts a fresh instance in this same page
   * instead of returning early forever.
   */
  function shutDown(reason) {
    if (disposed) {
      return;
    }
    disposed = true;
    undoRegistrations();
    releaseVideos();
    delete window[ALREADY_LOADED_FLAG];
    console.debug(`[Playback Speed Slider] stopped in this frame: ${reason}`);
  }

  /**
   * Whether this frame is still covered by the active patterns.
   *
   * A missing mirror means the service worker has not published one yet, not that
   * nothing is active: this frame was injected, which means Chrome had a permission for
   * it, so the benefit of the doubt goes to carrying on. An empty array is an answer,
   * and the answer is no.
   */
  function coversThisFrame(patterns) {
    if (!Array.isArray(patterns)) {
      return true;
    }
    return patterns.some((pattern) => patternCoversHost(pattern, location.hostname));
  }

  // The player's DOM mutates constantly, so coalesce mutation bursts into one
  // scan per animation frame instead of querying on every callback.
  function scheduleScan() {
    if (scanScheduled || disposed) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      applyToAllVideos();
    });
  }

  // Registers everything the script needs, undoing its own work if any step throws. A
  // frame left half-registered would keep reacting to events with no rate to apply, and
  // the retry that follows would double up the listeners it did manage to attach.
  function start() {
    try {
      const onStorageChanged = (changes, areaName) => {
        if (areaName !== 'local') {
          return;
        }
        if (changes[ACTIVE_KEY] && !coversThisFrame(changes[ACTIVE_KEY].newValue)) {
          shutDown('this site is no longer enabled');
          return;
        }
        if (!changes[STORAGE_KEY]) {
          return;
        }
        desiredRate = normalizeRate(changes[STORAGE_KEY].newValue);
        applyToAllVideos();
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
      undoAll.push(() => chrome.storage.onChanged.removeListener(onStorageChanged));

      const observer = new MutationObserver(scheduleScan);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      undoAll.push(() => observer.disconnect());

      // Safety net for videos that appear without a matching mutation record.
      document.addEventListener('play', scheduleScan, true);
      undoAll.push(() => document.removeEventListener('play', scheduleScan, true));

      // Read the stored state only once the listener above is in place, so a change
      // that lands while startup is still running is not missed.
      chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_RATE, [ACTIVE_KEY]: null }, (stored) => {
        if (disposed) {
          return;
        }
        if (chrome.runtime.lastError) {
          console.debug(
            '[Playback Speed Slider] could not read the stored rate:',
            chrome.runtime.lastError.message
          );
          return;
        }
        // Covers the tab that was open across a removal and then injected again, and
        // the frame whose site was removed while this read was in flight.
        if (!coversThisFrame(stored[ACTIVE_KEY])) {
          shutDown('this site is not enabled');
          return;
        }
        desiredRate = normalizeRate(stored[STORAGE_KEY]);
        applyToAllVideos();
      });
    } catch (error) {
      disposed = true;
      undoRegistrations();
      throw error;
    }
  }

  try {
    start();
    // Claimed only now, and only if startup did not already stop. A frame that threw
    // above is left exactly as it was found, so the next injection from the popup gets
    // to try again instead of returning early forever.
    if (!disposed) {
      window[ALREADY_LOADED_FLAG] = true;
    }
  } catch (error) {
    // Happens when the extension is reloaded and this frame's context is orphaned. The
    // freshly injected copy takes over, so there is nothing to recover here.
    console.debug(
      '[Playback Speed Slider] start failed; will retry on the next injection:',
      error
    );
  }
})();
