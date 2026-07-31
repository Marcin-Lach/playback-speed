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
  // extension was installed or reloaded, so guard against running twice.
  if (window[ALREADY_LOADED_FLAG]) {
    return;
  }
  window[ALREADY_LOADED_FLAG] = true;

  const STORAGE_KEY = 'playbackRate';
  const MIN_RATE = 0.1;
  const MAX_RATE = 4.0;
  const DEFAULT_RATE = 1.0;

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
  const trackedVideos = new WeakSet();

  const clampRate = (value) => {
    const rate = Number(value);
    if (!Number.isFinite(rate)) {
      return DEFAULT_RATE;
    }
    return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  };

  function applyRate(video) {
    try {
      // Writing the same value would be a no-op, but skipping it also avoids an
      // endless ratechange -> apply -> ratechange loop.
      if (video.playbackRate !== desiredRate) {
        video.playbackRate = desiredRate;
      }
      // defaultPlaybackRate makes the rate survive some of the player's own resets.
      if (video.defaultPlaybackRate !== desiredRate) {
        video.defaultPlaybackRate = desiredRate;
      }
    } catch (error) {
      // A detached or not-yet-initialised media element can throw; the next scan
      // or media event will pick it up again.
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
    for (const video of document.querySelectorAll('video')) {
      trackVideo(video);
      applyRate(video);
    }
  }

  // The Prime Video DOM mutates constantly, so coalesce mutation bursts into one
  // scan per animation frame instead of querying on every callback.
  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      applyToAllVideos();
    });
  }

  function watchForNewVideos() {
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Safety net for videos that appear without a matching mutation record.
    document.addEventListener('play', scheduleScan, true);
  }

  function watchStoredRate() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[STORAGE_KEY]) {
        return;
      }
      desiredRate = clampRate(changes[STORAGE_KEY].newValue);
      applyToAllVideos();
    });
  }

  function start() {
    chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_RATE }, (stored) => {
      desiredRate = clampRate(stored[STORAGE_KEY]);
      applyToAllVideos();
    });

    watchStoredRate();
    watchForNewVideos();
  }

  try {
    start();
  } catch (error) {
    // Happens when the extension is reloaded and this frame's context is orphaned.
    // The freshly injected copy takes over, so there is nothing to recover here.
    console.debug('[Prime Video Speed Controller] stopped:', error);
  }
})();
