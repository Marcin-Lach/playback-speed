// Popup: writes the chosen rate to chrome.storage.local and reports what the
// active tab is doing. The content script in every Prime Video frame watches that
// storage key, so the popup never has to talk to the page directly.
const STORAGE_KEY = 'playbackRate';
const MIN_RATE = 0.1;
const MAX_RATE = 4.0;
const DEFAULT_RATE = 1.0;
const WRITE_DEBOUNCE_MS = 80;
const PRIME_VIDEO_HOST = /(^|\.)primevideo\.com$/;

const slider = document.getElementById('rate-slider');
const readout = document.getElementById('rate-readout');
const status = document.getElementById('status');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

let writeTimer = null;
// Rates this popup wrote itself, so the storage listener below can ignore the
// echo instead of yanking the slider back while it is being dragged.
const selfWrittenRates = new Set();

/** Rounds to hundredths so the stored value never carries float noise. */
function normalizeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) {
    return DEFAULT_RATE;
  }
  return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 100) / 100;
}

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
  slider.value = String(rate);
  readout.textContent = `${formatRate(rate)}×`;
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(normalizeRate(button.dataset.rate) === rate));
  }
}

function storeRate(rate) {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    selfWrittenRates.add(rate);
    chrome.storage.local.set({ [STORAGE_KEY]: rate });
  }, WRITE_DEBOUNCE_MS);
}

function setRate(value) {
  const rate = normalizeRate(value);
  renderRate(rate);
  storeRate(rate);
}

/** Runs in the page: how many videos are here and what speed are they at? */
function inspectFrame() {
  const videos = Array.from(document.querySelectorAll('video'));
  return { count: videos.length, rates: videos.map((video) => video.playbackRate) };
}

async function reportActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let host = '';
  try {
    host = new URL(tab?.url ?? '').hostname;
  } catch (error) {
    host = '';
  }

  if (!PRIME_VIDEO_HOST.test(host)) {
    setStatus('Open a primevideo.com tab — the speed is saved and applied there.');
    return;
  }

  try {
    // Covers tabs that were already open when the extension was installed or
    // reloaded, where the declared content script never ran. Injecting twice is
    // harmless: content.js guards against it.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js'],
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
    setStatus('Could not reach this tab. Reload the Prime Video page and try again.', 'warn');
  }
}

slider.addEventListener('input', () => setRate(slider.value));

for (const button of presetButtons) {
  button.addEventListener('click', () => setRate(button.dataset.rate));
}

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
  renderRate(normalizeRate(stored[STORAGE_KEY]));
  reportActiveTab();
});
