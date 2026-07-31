// Content script: keeps every <video> in this frame at the speed chosen in the popup.
//
// The extension is injected into all frames, so each frame only ever touches its own
// documents. That avoids the cross-origin iframe problem the DevTools one-liner has.
//
// The single source of truth is chrome.storage.local, which means:
//   * the popup only has to write the new value, and
//   * every frame in every Prime Video tab picks it up through storage.onChanged.
(() => {
  const ALREADY_LOADED_FLAG = '__primeVideoSpeedControllerLoaded';

  // The popup re-injects this file to cover tabs that were already open when the
  // extension was installed or reloaded, so guard against running twice. The flag is
  // claimed at the bottom of this file and only once start() has succeeded, so a frame
  // that failed to start stays eligible for a retry on the next injection.
  if (window[ALREADY_LOADED_FLAG]) {
    return;
  }

  const rateApi = globalThis.PrimeVideoSpeedRate;
  if (!rateApi) {
    // shared/rate.js is injected alongside this file; without it there is no range to
    // clamp against. Returning without claiming the flag leaves the retry open.
    console.debug('[Prime Video Speed Controller] shared/rate.js is missing; not starting.');
    return;
  }
  const { DEFAULT_RATE, normalizeRate } = rateApi;

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

  // Prime Video resets playbackRate whenever it swaps the media source: starting a
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
  // Set when start() rolls itself back, so callbacks already in flight become no-ops
  // instead of racing the replacement instance that the next injection creates.
  let disposed = false;
  const trackedVideos = new WeakSet();
  const writeBudgets = new WeakMap();

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
          '[Prime Video Speed Controller] write budget for this video is used up for the ' +
            'current second; backing off. Something else is competing for playbackRate.'
        );
      }
      return false;
    }

    budget.writes += 1;
    return true;
  }

  function applyRate(video) {
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
      console.debug('[Prime Video Speed Controller] could not set the rate on a video:', error);
    }
  }

  function trackVideo(video) {
    if (trackedVideos.has(video)) {
      return;
    }
    trackedVideos.add(video);
    for (const eventName of REAPPLY_EVENTS) {
      video.addEventListener(eventName, () => applyRate(video));
    }
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

  // The Prime Video DOM mutates constantly, so coalesce mutation bursts into one
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
    const undoAll = [];

    try {
      const onStorageChanged = (changes, areaName) => {
        if (areaName !== 'local' || !changes[STORAGE_KEY]) {
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

      // Read the stored rate only once the listener above is in place, so a change that
      // lands while startup is still running is not missed.
      chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_RATE }, (stored) => {
        if (disposed) {
          return;
        }
        if (chrome.runtime.lastError) {
          console.debug(
            '[Prime Video Speed Controller] could not read the stored rate:',
            chrome.runtime.lastError.message
          );
          return;
        }
        desiredRate = normalizeRate(stored[STORAGE_KEY]);
        applyToAllVideos();
      });
    } catch (error) {
      disposed = true;
      for (const undo of undoAll.reverse()) {
        try {
          undo();
        } catch (undoError) {
          console.debug('[Prime Video Speed Controller] cleanup failed:', undoError);
        }
      }
      throw error;
    }
  }

  try {
    start();
    // Claimed only now. A frame that threw above is left exactly as it was found, so the
    // next injection from the popup gets to try again instead of returning early forever.
    window[ALREADY_LOADED_FLAG] = true;
  } catch (error) {
    // Happens when the extension is reloaded and this frame's context is orphaned. The
    // freshly injected copy takes over, so there is nothing to recover here.
    console.debug(
      '[Prime Video Speed Controller] start failed; will retry on the next injection:',
      error
    );
  }
})();
