// Popup: writes the chosen rate to chrome.storage.local and reports what the
// active tab is doing. The content script in every matching frame watches that
// storage key, so the popup never has to talk to the page directly.
const { MIN_RATE, MAX_RATE, RATE_STEP, DEFAULT_RATE, normalizeRate } = globalThis.PlaybackSpeedRate;

const STORAGE_KEY = 'playbackRate';
const WRITE_DEBOUNCE_MS = 80;
// Must stay in step with the host patterns declared in manifest.json: this only decides
// whether the popup bothers to inject into the active tab and report on it.
const SUPPORTED_HOSTS = [/(^|\.)primevideo\.com$/, /(^|\.)disneyplus\.com$/];
// Injected together and in this order: content.js reads the shared range from the first
// file, so it cannot be injected on its own.
const CONTENT_SCRIPT_FILES = ['shared/rate.js', 'content.js'];

const slider = document.getElementById('rate-slider');
const readout = document.getElementById('rate-readout');
const status = document.getElementById('status');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

let writeTimer = null;
// The rate waiting to be written, or null when nothing is pending. Held outside the
// timer so that flushWrite() can commit it from a teardown path.
let pendingRate = null;
// Rates this popup wrote itself, so the storage listener below can ignore the
// echo instead of yanking the slider back while it is being dragged.
const selfWrittenRates = new Set();

/** 1 -> "1.0", 1.25 -> "1.25" */
function formatRate(rate) {
  const hundredths = Math.round(rate * 100);
  return (hundredths / 100).toFixed(hundredths % 10 === 0 ? 1 : 2);
}

function setStatus(message, tone = 'info') {
  status.textContent = message;
  status.dataset.tone = tone;
}

function renderRate(rate) {
  const label = `${formatRate(rate)}×`;
  slider.value = String(rate);
  // Without this a screen reader announces the bare number from slider.value, which is
  // the step-snapped one and carries no unit.
  slider.setAttribute('aria-valuetext', label);
  readout.textContent = label;
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(normalizeRate(button.dataset.rate) === rate));
  }
}

/**
 * Commits the pending rate now.
 *
 * A popup document is destroyed the moment it loses focus, and a scheduled timer dies
 * with it, so every teardown path has to come through here or the user's last change is
 * silently dropped after the readout has already shown it. chrome.storage.local.set
 * dispatches synchronously, so the write still lands even when the callback never runs.
 */
function flushWrite() {
  if (pendingRate === null) {
    return;
  }

  clearTimeout(writeTimer);
  writeTimer = null;
  const rate = pendingRate;
  pendingRate = null;

  selfWrittenRates.add(rate);
  chrome.storage.local.set({ [STORAGE_KEY]: rate }, () => {
    if (chrome.runtime.lastError) {
      setStatus('Could not save the speed. Try again.', 'warn');
    }
  });
}

function storeRate(rate) {
  pendingRate = rate;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
}

function setRate(value) {
  const rate = normalizeRate(value);
  renderRate(rate);
  storeRate(rate);
}

/**
 * Points the slider at the shared range, and checks that every preset can actually be
 * represented on it. A preset that is not a whole number of steps above the minimum gets
 * snapped by the browser, leaving the thumb somewhere other than the value in the
 * readout and the value that was stored.
 */
function configureSlider() {
  slider.min = String(MIN_RATE);
  slider.max = String(MAX_RATE);
  slider.step = String(RATE_STEP);

  for (const button of presetButtons) {
    const rate = normalizeRate(button.dataset.rate);
    const steps = (rate - MIN_RATE) / RATE_STEP;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      console.warn(
        `[Playback Speed Slider] preset ${rate}× is not a multiple of the ` +
          `${RATE_STEP} step above ${MIN_RATE}, so the slider will snap away from it.`
      );
    }
  }
}

/** Runs in the page: how many videos are here and what speed are they at? */
function inspectFrame() {
  const videos = Array.from(document.querySelectorAll('video'));
  return { count: videos.length, rates: videos.map((video) => video.playbackRate) };
}

async function reportActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let url = null;
  try {
    url = new URL(tab?.url ?? '');
  } catch (error) {
    url = null;
  }

  const hostIsSupported = url && SUPPORTED_HOSTS.some((pattern) => pattern.test(url.hostname));
  if (!url || url.protocol !== 'https:' || !hostIsSupported) {
    setStatus('Open a supported video tab — the speed is saved and applied there.');
    return;
  }

  try {
    // Covers tabs that were already open when the extension was installed or
    // reloaded, where the declared content script never ran. Injecting twice is
    // harmless: content.js guards against it.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: CONTENT_SCRIPT_FILES,
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: inspectFrame,
    });

    const frames = results.map((result) => result.result).filter(Boolean);
    const count = frames.reduce((total, frame) => total + frame.count, 0);

    if (count === 0) {
      setStatus('No video on this tab yet. Start playing — the speed applies automatically.');
      return;
    }

    const rates = frames.flatMap((frame) => frame.rates);
    const applied = rates.map((rate) => `${formatRate(normalizeRate(rate))}×`);
    const label = count === 1 ? 'video' : 'videos';
    setStatus(`${count} ${label} on this tab, now playing at ${[...new Set(applied)].join(', ')}.`);
  } catch (error) {
    setStatus('Could not reach this tab. Reload the page and try again.', 'warn');
  }
}

configureSlider();

slider.addEventListener('input', () => setRate(slider.value));
// A committed drag or keyboard nudge does not need to wait out the debounce.
slider.addEventListener('change', flushWrite);

for (const button of presetButtons) {
  button.addEventListener('click', () => {
    setRate(button.dataset.rate);
    flushWrite();
  });
}

// Both paths a popup can disappear through, so a pending write is never lost.
window.addEventListener('pagehide', flushWrite);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushWrite();
  }
});

// Keep the popup in sync if another window's popup changed the rate.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY]) {
    return;
  }
  const rate = normalizeRate(changes[STORAGE_KEY].newValue);
  if (selfWrittenRates.delete(rate)) {
    return;
  }
  renderRate(rate);
});

chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_RATE }, (stored) => {
  if (chrome.runtime.lastError) {
    renderRate(DEFAULT_RATE);
    setStatus('Could not read the saved speed.', 'warn');
    return;
  }
  renderRate(normalizeRate(stored[STORAGE_KEY]));
  reportActiveTab();
});
