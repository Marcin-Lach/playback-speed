# Playback Speed Slider

A small, unpacked Chrome extension that adds a playback speed slider to a streaming site whose
player offers no speed control of its own. It sets `playbackRate` on the `<video>` element
directly — the same trick as running a one-liner in DevTools, but packaged, persistent, and
re-applied automatically when the player resets itself.

The sites it runs on are whatever host patterns are declared in
[manifest.json](manifest.json) (`host_permissions` and the content script `matches`). Nothing
outside those patterns is touched.

It is meant for local, personal use and is not published on the Chrome Web Store.
Works only on Prime Video.

## Features

- Slider from **0.1× to 4.0×** in 0.05 steps, with a live readout.
- Preset buttons for the speeds you actually use: 0.5×, 1×, 1.25×, 1.5×, 1.75×, 2×, 2.5×, 3×.
- The chosen speed is **remembered** and applied to every matching tab, including new ones and
  the next title you start.
- **Survives player resets.** Players typically set `playbackRate` back to 1 when they swap the
  media source (starting a title, coming back from an ad break, seeking across a stream
  boundary); the extension notices and re-applies your speed.
- Works when the player lives inside a same-origin iframe, because the content script is injected
  into all frames and each frame handles its own `<video>` elements.
- No network access, no tracking, and no third-party code. Besides the host patterns in
  `manifest.json`, the extension asks only for `storage` (to remember your speed) and `scripting`
  (to reach tabs that were already open — see [How it works](#how-it-works)).

## Installation

1. Clone or download this repository to a folder you will keep — Chrome loads the extension from
   this path on every start, so don't put it in a temp directory.

   ```bash
   git clone <repo-url> playback-speed-slider
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the folder containing `manifest.json` (the repository root).
5. The blue fast-forward icon appears in the toolbar. Click **Details → Pin** (or the puzzle-piece
   menu) if you want it permanently visible.

That's it. Any matching tab that was already open when you installed the extension is handled
too — opening the popup injects the content script into it, so no reload is required.

The same steps work in other Chromium browsers (Edge, Brave, Vivaldi) via their own
`Load unpacked` flow.

## Usage

1. Start playing something on a matching site.
2. Click the extension icon.
3. Drag the slider, or click a preset. The speed applies immediately — no reload, no reopening.

Notes:

- With the slider focused, the **arrow keys** nudge the speed by 0.05 and **Home**/**End** jump to
  0.1× and 4.0×.
- The speed is a single global setting, not per-tab: changing it affects every open matching tab
  and stays in effect until you change it back. To go back to normal, click the **1×** preset.
- Audio pitch is not corrected, so very high or very low speeds sound like a chipmunk or a
  slowed-down record. That is browser behaviour, not something the extension can fix.
- Above roughly 3× the browser may drop audio entirely or stutter on high-bitrate streams; this
  depends on your machine, not on the extension.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 declaration: host patterns, content script, popup, permissions. |
| `shared/rate.js` | The rate range (min, max, step, default) and the `normalizeRate` clamp, defined once and used by both the popup and the content script. |
| `content.js` | Injected into every matching frame. Applies the stored rate to all `<video>` elements, tracks new ones with a `MutationObserver`, and re-applies on media events. |
| `popup/popup.html` / `.css` / `.js` | The slider UI. Writes the chosen rate to `chrome.storage.local` and reports how many videos the active tab has. |
| `icons/` | Toolbar icons at 16/32/48/128 px. |

`chrome.storage.local` is the single source of truth. The popup only writes to it; every content
script listens with `chrome.storage.onChanged` and applies the new value. That keeps all frames and
all tabs in sync without any tab-to-tab messaging.

The `scripting` permission exists for one purpose: when the popup opens, it re-injects
`shared/rate.js` and `content.js` into the active tab so tabs that predate the install (or an
extension reload) start working without a page refresh. `content.js` sets a flag on `window` and
returns early if it is already running, so repeated injection is harmless. The flag is only set
once startup has succeeded, so a frame that failed to start is retried on the next injection
instead of staying inert until the page is reloaded.

## Customising

- **Change the range or step**: edit `MIN_RATE`, `MAX_RATE`, and `RATE_STEP` in
  [shared/rate.js](shared/rate.js). That is the only place they are defined — the slider reads its
  bounds from there at startup, and both the popup and the content script clamp against it.
- **Change the presets**: add or remove `<button class="preset" data-rate="…">` elements in
  [popup/popup.html](popup/popup.html). The grid is four columns wide, so multiples of four look
  best. Each `data-rate` must be a whole number of `RATE_STEP`s above `MIN_RATE`, or the browser
  snaps the slider thumb away from the value shown in the readout; the popup logs a console warning
  if a preset breaks that rule.
- **Add or change the sites it runs on**: add the pattern to both `host_permissions` and the
  content script `matches` array in [manifest.json](manifest.json), and add the matching hostname
  to the `SUPPORTED_HOST` regex in [popup/popup.js](popup/popup.js) so the popup reports on those
  tabs too. Then reload the extension; Chrome will ask you to approve the new host permission.
  Note that playback on a different origin — even the same company's other domain — is a separate
  host pattern.

After editing any file, press the reload arrow on the extension's card in `chrome://extensions`.
Changes to `content.js` only reach already-open tabs when you reopen the popup or reload the tab.

## Troubleshooting

**The popup says "No video on this tab yet."**
Playback hasn't created the `<video>` element yet, or you are on a browse page rather than a
player page. Start a title; the speed applies on its own.

**The popup says "Could not reach this tab."**
Chrome refused to inject into the page — usually because the extension was reloaded while the tab
stayed open. Reload the tab.

**Speed snaps back to 1× mid-playback.**
The player replaced the media source and the re-apply didn't catch it. Reopen the popup and nudge
the slider. If it happens consistently at a particular moment, add the relevant media event to
`REAPPLY_EVENTS` in [content.js](content.js).

**Nothing happens at all.**
Confirm the tab's URL matches a pattern declared in [manifest.json](manifest.json), that the
extension is enabled on `chrome://extensions`, and that its card shows no errors.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by any streaming provider. Trademarks referenced in
configuration are the property of their respective owners. The extension only changes the playback
rate of a `<video>` element through the standard browser API; it does not touch digital rights
management, download or redistribute content, or alter anything server-side.

## License

MIT — do whatever you like with it. See [LICENSE](LICENSE) for the full text.
