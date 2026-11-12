// Popup: writes the chosen rate to chrome.storage.local and reports what the
// active tab is doing. The content script in every permitted frame watches that
// storage key, so the popup never has to talk to the page directly.
//
// It is also where a new site gets added. Which sites the extension may touch is
// decided by Chrome's permission set, not by a list in this file, so the popup asks
// chrome.permissions about the active tab rather than matching its URL against
// hard-coded patterns.
const { MIN_RATE, MAX_RATE, RATE_STEP, DEFAULT_RATE, normalizeRate } = globalThis.PlaybackSpeedRate;
const { patternForUrl, exactPatternForUrl, hostLabel, listedPatternForHost, readSites, addSite } =
  globalThis.PlaybackSpeedSites;

const STORAGE_KEY = 'playbackRate';
const WRITE_DEBOUNCE_MS = 80;
// Injected together and in this order: content.js reads the shared range and the site
// matching from the first two files, so it cannot be injected on its own.
const CONTENT_SCRIPT_FILES = ['shared/rate.js', 'shared/sites.js', 'content.js'];

const slider = document.getElementById('rate-slider');
const readout = document.getElementById('rate-readout');
const status = document.getElementById('status');
const enableButton = document.getElementById('enable-site');
const reloadButton = document.getElementById('reload-tab');
const optionsButton = document.getElementById('open-options');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

let writeTimer = null;
// The rate waiting to be written, or null when nothing is pending. Held outside the
// timer so that flushWrite() can commit it from a teardown path.
let pendingRate = null;
// Rates this popup wrote itself, so the storage listener below can ignore the
// echo instead of yanking the slider back while it is being dragged.
const selfWrittenRates = new Set();

// The active tab, the permission this popup would ask for to cover it, and whether
// granting it should also put the site on the list. All three are worked out while
// rendering, because chrome.permissions.request() has to be called straight out of the
// click that triggers it: anything awaited first spends the user gesture and Chrome
// rejects the request.
let activeTabId = null;
let patternToRequest = null;
let patternIsListed = false;

/** 1 -> "1.0", 1.25 -> "1.25" */
function formatRate(rate) {
  const hundredths = Math.round(rate * 100);
  return (hundredths / 100).toFixed(hundredths % 10 === 0 ? 1 : 2);
}

function setStatus(message, tone = 'info') {
  status.textContent = message;
  status.dataset.tone = tone;
}

/**
 * The popup has one action slot; this is the only place that decides what fills it.
 *
 * `controls` turns the slider and presets on or off. They stay live wherever changing
 * the speed does something — including on a tab that is not a video page at all, since
 * the rate is one global setting that other tabs are already following. They are
 * switched off only on a site the extension is not allowed to touch, where a working
 * slider would be a lie: the value would be stored and visibly applied to nothing.
 */
function showActions({ enable = null, reload = false, controls = true } = {}) {
  enableButton.hidden = enable === null;
  if (enable !== null) {
    enableButton.textContent = enable;
  }
  reloadButton.hidden = !reload;

  slider.disabled = !controls;
  for (const button of presetButtons) {
    button.disabled = !controls;
  }
  document.body.classList.toggle('controls-off', !controls);
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

/** Injects into a permitted tab and reports what it found. */
async function reportPermittedTab(tabId) {
  try {
    // Covers tabs that were already open when the extension was installed, when it was
    // reloaded, or when their site was added from here — none of which run the declared
    // content script on their own. Injecting twice is harmless: content.js guards
    // against it.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_SCRIPT_FILES,
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: inspectFrame,
    });

    const frames = results.map((result) => result.result).filter(Boolean);
    const count = frames.reduce((total, frame) => total + frame.count, 0);

    if (count === 0) {
      setStatus('No video on this tab yet. Start playing — the speed applies automatically.');
      // A reload is the usual cure when the player was already running before the site
      // was permitted, so offer it rather than leaving the user to guess.
      showActions({ reload: true });
      return;
    }

    const rates = frames.flatMap((frame) => frame.rates);
    const applied = rates.map((rate) => `${formatRate(normalizeRate(rate))}×`);
    const label = count === 1 ? 'video' : 'videos';
    setStatus(`${count} ${label} on this tab, now playing at ${[...new Set(applied)].join(', ')}.`);
    showActions();
  } catch (error) {
    setStatus('Could not reach this tab. Reload the page and try again.', 'warn');
    showActions({ reload: true });
  }
}

/**
 * Works out what this popup should say about the active tab, and what it should offer.
 *
 * `justAdded` is the state right after the user granted a site from here: the page is
 * still the one that loaded without a content script, so the useful action is a reload
 * rather than a report of videos it does not yet control.
 */
async function refreshSiteState({ justAdded = false } = {}) {
  activeTabId = null;
  patternToRequest = null;
  patternIsListed = false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  let url = null;
  try {
    url = new URL(tab?.url ?? '');
  } catch (error) {
    url = null;
  }

  // Only https can be added: it is the whole of what optional_host_permissions declares,
  // so asking for anything else would be refused by Chrome.
  if (!url || url.protocol !== 'https:') {
    setStatus('This tab is not a video site. The speed applies to the sites you enabled.');
    showActions();
    return;
  }

  const host = url.hostname;
  const [granted, sites] = await Promise.all([
    chrome.permissions.contains({ origins: [exactPatternForUrl(url)] }),
    readSites(),
  ]);

  if (!granted) {
    // A site can be on the list without being granted — the seeded defaults start that
    // way, and so does anything whose permission prompt was declined or later revoked.
    // Asking again then means asking for the pattern already on the list, not a second
    // entry for the same site.
    const listed = listedPatternForHost(sites, host);
    patternIsListed = listed !== null;
    patternToRequest = listed ?? patternForUrl(url);

    if (!patternToRequest) {
      setStatus(`${host} cannot be added as a site.`, 'warn');
      showActions({ controls: false });
      return;
    }
    setStatus(
      patternIsListed
        ? `Off on ${host}: it is on your list, but Chrome has not granted access to it.`
        : `Off on ${host}: the extension is not allowed to run here.`
    );
    showActions({
      enable: patternIsListed
        ? `Grant access to ${hostLabel(patternToRequest)}`
        : `Enable on ${hostLabel(patternForUrl(url))}`,
      controls: false,
    });
    return;
  }

  if (justAdded) {
    setStatus(`${host} enabled. Reload the page to start controlling its speed.`);
    showActions({ reload: true });
    return;
  }

  await reportPermittedTab(tab.id);
}

enableButton.addEventListener('click', () => {
  const pattern = patternToRequest;
  const wasListed = patternIsListed;
  if (!pattern) {
    return;
  }

  // Called first, with nothing awaited before it, so the click still counts as the user
  // gesture Chrome requires. Chrome closes this popup while its own prompt is up, in
  // which case the callback below never runs — the permission is still granted, and
  // reopening the popup shows the reload state, so nothing is lost.
  try {
    chrome.permissions.request({ origins: [pattern] }, (accepted) => {
      if (chrome.runtime.lastError) {
        setStatus(`Chrome refused the request: ${chrome.runtime.lastError.message}`, 'warn');
        return;
      }
      if (!accepted) {
        setStatus(`Chrome did not grant access to ${hostLabel(pattern)}.`, 'warn');
        return;
      }
      // Only a site that was not already on the list needs adding; the service worker
      // would reconcile it anyway, but doing it here means the options page shows it
      // immediately rather than after the worker next wakes.
      if (!wasListed) {
        addSite(pattern);
      }
      refreshSiteState({ justAdded: true });
    });
  } catch (error) {
    // A request Chrome will not even consider throws rather than reporting through
    // lastError. Say so instead of leaving the button looking dead.
    setStatus(`Chrome refused the request: ${error.message}`, 'warn');
  }
});

reloadButton.addEventListener('click', () => {
  if (activeTabId === null) {
    return;
  }
  chrome.tabs.reload(activeTabId);
  window.close();
});

optionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

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
  refreshSiteState();
});
