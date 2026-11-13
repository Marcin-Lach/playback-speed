# Playback Speed Slider

A small, unpacked Chrome extension that adds a playback speed slider to a streaming site whose
player offers no speed control of its own. It sets `playbackRate` on the `<video>` element
directly — the same trick as running a one-liner in DevTools, but packaged, persistent, and
re-applied automatically when the player resets itself.

**Prime Video** and **Disney+** are on the site list to begin with, and both can be removed like
any other entry. Sites are managed from the extension — from the popup while you are on one, or
from the options page — and never by editing the source.

It is meant for local, personal use and is not published on the Chrome Web Store.

## Two halves of a site

Every site, including the two that come pre-listed, has two independent states, and the UI shows
both:

- **Listed** — it is on this extension's own list, stored in `chrome.storage.local`.
- **Granted** — Chrome has given the extension permission to run there, after you approved a
  prompt.

The slider only works where both are true. A newly listed site is not granted until you approve
it, and revoking access in `chrome://extensions` leaves the site listed but not granted, with a
**Grant** button waiting. This split is why every site is removable: the extension declares no
required host permissions at all, so there is nothing Chrome refuses to let go of.

## Features

- Slider from **0.1× to 4.0×** in 0.05 steps, with a live readout.
- Preset buttons for the speeds you actually use: 0.5×, 1×, 1.25×, 1.5×, 1.75×, 2×, 2.5×, 3×.
- **Add any site from the popup.** On a site that is not enabled yet, the popup offers a button
  to enable it, then a button to reload the page so the slider takes effect.
- **Embedded players are found for you.** The popup lists every origin the page draws video
  from — the page itself and each embedded player, such as `player.vimeo.com` — with an
  **Enable** button on the ones that are not allowed yet, and a ▶ against the one that is
  actually playing.
- **Removing a site takes effect in tabs that are already open.** The frames stop, hand back
  their videos at 1×, and go quiet, rather than carrying on until the page is reloaded.
- **The slider is disabled on sites the extension may not touch**, so a control that would do
  nothing never looks live. It stays enabled on ordinary tabs, where changing the speed still
  reaches the enabled tabs you have open.
- **An options page** listing every site and whether it is granted, with **Grant**, **Grant
  access to all**, and **Remove**. Reachable from `chrome://extensions` → the extension's
  **Details** → **Extension options**, or from **Manage sites** in the popup.
- **Prime Video and Disney+ are defaults, not special cases.** They are the initial contents of
  the list and nothing in the code treats them differently; remove either one and it stays
  removed.
- **One exact host per entry.** `vodservice.com` does not cover `www.vodservice.com` or
  `video.vodservice.com` — the popup lists whichever host is actually playing, so there is
  nothing to guess at and no permission granted wider than what was asked for.
- The chosen speed is **remembered** and applied to every enabled tab, including new ones and
  the next title you start.
- **Survives player resets.** Players typically set `playbackRate` back to 1 when they swap the
  media source (starting a title, coming back from an ad break, seeking across a stream
  boundary); the extension notices and re-applies your speed.
- Works when the player lives inside a same-origin iframe, because the content script is injected
  into all frames and each frame handles its own `<video>` elements.
- No network access, no tracking, and no third-party code. Besides the sites you grant, the
  extension asks only for `storage` (the speed and the site list), `scripting` (to run on the
  sites you grant and to reach tabs that were already open), and `activeTab` (to see which site
  the popup is looking at, so it can offer to enable it).

## Installation

1. Clone or download this repository to a folder you will keep — Chrome loads the extension from
   this path on every start, so don't put it in a temp directory.

   ```bash
   git clone <repo-url> playback-speed-slider
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the folder containing `manifest.json` (the repository root).
5. The options page opens by itself, showing Prime Video and Disney+ as listed but not granted.
   Click **Grant access to all** and approve Chrome's prompt. Nothing works until at least one
   site is granted.
6. The blue fast-forward icon appears in the toolbar. Click **Details → Pin** (or the puzzle-piece
   menu) if you want it permanently visible.

Any tab that was already open when you granted its site is handled too — opening the popup
injects the content script into it, so no reload is strictly required, though the popup offers
one when it finds no video.

The same steps work in other Chromium browsers (Edge, Brave, Vivaldi) via their own
`Load unpacked` flow.

## Usage

1. Start playing something on a granted site.
2. Click the extension icon.
3. Drag the slider, or click a preset. The speed applies immediately — no reload, no reopening.

Notes:

- With the slider focused, the **arrow keys** nudge the speed by 0.05 and **Home**/**End** jump to
  0.1× and 4.0×.
- The speed is a single global setting, not per-tab: changing it affects every open granted tab
  and stays in effect until you change it back. To go back to normal, click the **1×** preset.
- Audio pitch is not corrected, so very high or very low speeds sound like a chipmunk or a
  slowed-down record. That is browser behaviour, not something the extension can fix.
- Above roughly 3× the browser may drop audio entirely or stutter on high-bitrate streams; this
  depends on your machine, not on the extension.

## Managing sites

**From the popup, while you are on the site.** Open a page on it over https and click the
extension icon:

- Not listed at all → **Enable on `example.com`**, which asks Chrome for access and adds the site
  to the list.
- Listed but not granted → **Grant access to `example.com`**, which asks for the permission the
  existing entry needs, without creating a second entry.

Either way, approving the prompt leaves the popup offering **Reload page**, which is needed once
because the page was loaded before the extension was allowed to run on it.

Chrome closes the popup while its permission prompt is open. If that happens, accept the prompt
and click the extension icon again — the permission was still granted, and the popup comes back
with the **Reload page** button.

**From the options page.** Open it from **Manage sites** in the popup, or in `chrome://extensions`
from the extension's **Details → Extension options**.

- **Add** takes `example.com` or a full URL like `https://video.example.com/watch` (the hostname
  is taken from it). The site joins the list immediately and the permission prompt follows; if you
  decline it, the entry stays on the list as *not granted* with a **Grant** button, so nothing you
  typed is lost.
- **Grant** asks for one site. **Grant access to all** appears when two or more are waiting and
  asks for them in a single prompt.
- **Remove** takes the site off the list and revokes its permission. It applies to the two
  pre-listed sites as well — they are seeded once, on the first run that finds no list at all, and
  are never seeded again, so removing one is permanent.

A site is listed as **one exact host**. `example.com`, `www.example.com` and
`player.example.com` are three separate entries, and enabling one says nothing about the others.
That is deliberate: earlier versions added `*.` to everything on the theory that a user enabling
`example.com` would also want whatever subdomain the player lived on, but the popup now lists
every host a page plays video from, so the one that needs enabling is on screen and nothing has
to be widened on a guess.

Entries granted by an earlier version keep their `*.` and keep working; the options page labels
them *this host and its subdomains* so they are distinguishable from the exact ones.

Granted sites also appear under **Site access** on the extension's card in `chrome://extensions`,
and access can be revoked there. The options page notices: the site stays listed, and its row
turns back into a **Grant** button. Granting a site from Chrome's own UI works too — the
extension adds anything it finds granted but unlisted to the list.

## Embedded players

A page is not one thing. When a site embeds a player — `xyzasd.com` showing a video from
`player.vimeo.com` — the `<video>` lives in the player's own document, on its own origin.
Chrome decides what an extension may touch per frame, so a permission for the page says
nothing about the player: enabling `xyzasd.com` alone leaves the slider doing nothing, and
there is no way around that. `activeTab` does not bridge it either, since it covers the top
frame and same-origin children only.

So the popup lists **every origin the page draws video from**, one row each:

| | |
| --- | --- |
| ▶ | playing right now — this is the origin that matters |
| ⏸ | has a video, not playing |
| · | enabled, but no video in that frame |
| ? | not enabled, so its videos cannot be seen from here |
| ! | enabled, but the frame was not reachable — reload the page |

The row for the page itself is marked `page`. Rows that are not enabled carry an **Enable**
button (or **Grant**, when the site is already on the list and only the permission is
missing). Enabling the row with the ▶ against it is usually all that is needed — the page's
own origin often has no video at all and never has to be enabled.

Finding the embeds costs no permission. The popup probes the frames it may already touch and
reads the `src` of the iframes it finds there; reading a child frame's `src` attribute is a
read of the parent's own DOM, so an embed is discoverable long before anything may run inside
it. What cannot be seen without permission is what is *inside* an embed, which is why an
unenabled row shows `?` rather than a video count.

The speed itself stays a single setting. Once an origin is enabled, every video in every one
of its frames follows the slider, so one control covers the whole page.

The ▶ marker is also there for later: the site list accumulates player origins, and it tells
you which ones a page actually used when you come back to prune them.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 declaration. Declares no host permissions at all, only `optional_host_permissions` for https, plus the service worker, the popup, and the options page. |
| `shared/rate.js` | The rate range (min, max, step, default) and the `normalizeRate` clamp, defined once and used by both the popup and the content script. |
| `shared/sites.js` | The site list: the seeded defaults, reading and writing `chrome.storage.local`, turning what a human typed into a match pattern, and matching a pattern against a hostname. Used by the popup, the options page, and the service worker. |
| `background.js` | Service worker. Registers and unregisters the content script for the sites that are both listed and granted, and reconciles the list with Chrome's permissions. |
| `content.js` | Injected into every enabled frame. Applies the stored rate to all `<video>` elements, tracks new ones with a `MutationObserver`, and re-applies on media events. |
| `popup/popup.html` / `.css` / `.js` | The slider UI, plus one row per origin the page draws video from: enable or grant each one, reload when a frame needs it, and report what is playing. |
| `options/options.html` / `.css` / `.js` | The site list: add, grant, remove, and see what is granted. |
| `icons/` | Toolbar icons at 16/32/48/128 px. |

`chrome.storage.local` holds three things: `playbackRate`, the single source of truth for the
speed; `sites`, the list; and `activePatterns`, which the service worker rewrites on every sync
with the patterns that are currently both listed and granted.

That third key exists because of a Chrome behaviour that is easy to miss: **revoking a host
permission does not stop a content script that is already running.** It keeps its listeners, and
its access to extension storage, until the page navigates. A content script cannot ask
`chrome.permissions` anything either — that API is not exposed to it. So `activePatterns` is the
channel: every injected frame watches it, and one that is no longer covered unregisters its
listeners, resets its videos to 1×, and gives up its loaded flag so a later injection can start it
again without a page reload. The popup only writes the rate; every content script listens with
`chrome.storage.onChanged` and applies the new value, which keeps all frames and all tabs in sync
without any tab-to-tab messaging.

The list is seeded with `DEFAULT_SITE_PATTERNS` from `shared/sites.js` the first time the
extension finds no list stored — not an empty list, but none at all. That distinction is what
makes the defaults removable: once anything has been written, including `[]`, the seed never runs
again.

Because nothing is declared in `content_scripts`, Chrome injects nothing on its own.
`background.js` registers a single dynamic content script with
`chrome.scripting.registerContentScripts`, whose `matches` are the patterns that are **both**
listed and granted. It re-derives that set from scratch on every trigger — install, browser
startup, a permission added or removed, a change to the stored list, and any cold start of the
worker — because both halves can change while the worker is not running.

The `scripting` permission also covers the popup: when it opens on a granted site, it re-injects
`shared/rate.js` and `content.js` into the active tab, so tabs that predate the install (or an
extension reload, or granting their site) start working without a page refresh. `content.js` sets
a flag on `window` and returns early if it is already running, so repeated injection is harmless.
The flag is only set once startup has succeeded, so a frame that failed to start is retried on the
next injection instead of staying inert until the page is reloaded.

Both the popup and the options page call `chrome.permissions.request()` directly inside the click
that triggers it, with nothing awaited first. Chrome only honours a permission request that is
still inside the user gesture that started it, so each handler reads what it needs from state the
last render captured instead of awaiting a fresh read.

## Customising

- **Change the range or step**: edit `MIN_RATE`, `MAX_RATE`, and `RATE_STEP` in
  [shared/rate.js](shared/rate.js). That is the only place they are defined — the slider reads its
  bounds from there at startup, and both the popup and the content script clamp against it.
- **Change the presets**: add or remove `<button class="preset" data-rate="…">` elements in
  [popup/popup.html](popup/popup.html). The grid is four columns wide, so multiples of four look
  best. Each `data-rate` must be a whole number of `RATE_STEP`s above `MIN_RATE`, or the browser
  snaps the slider thumb away from the value shown in the readout; the popup logs a console warning
  if a preset breaks that rule.
- **Add sites**: use the popup or the options page — see [Managing sites](#managing-sites). No file
  needs editing.
- **Change which sites are listed by default**: edit `DEFAULT_SITE_PATTERNS` in
  [shared/sites.js](shared/sites.js). It only affects installs that have no list yet; an existing
  install keeps whatever is in storage. To re-seed one, remove the `sites` key from the
  extension's storage (DevTools console on the options page:
  `chrome.storage.local.remove('sites')`).
- **Allow http as well as https**: `optional_host_permissions` in [manifest.json](manifest.json)
  declares `https://*/*` only, and `shared/sites.js` builds `https://` patterns to match. Both
  would have to change.

After editing any file, press the reload arrow on the extension's card in `chrome://extensions`.
Changes to `content.js` only reach already-open tabs when you reopen the popup or reload the tab.

## Troubleshooting

**The popup is stuck on "Checking this tab…" with the controls still live.**
Fixed in 1.3.0. A frame with no hostname — an `about:blank` or `srcdoc` iframe, which pages
carry routinely — made the popup build an invalid permission pattern, and the resulting
rejection killed the refresh before it could say anything. Reload the extension on
`chrome://extensions`. If a popup ever fails now it says so and offers a reload.

**After updating, Prime Video and Disney+ stopped working.**
Earlier versions declared them as required host permissions. They are now ordinary list entries,
and Chrome dropped the old grants when the manifest stopped requiring them. Open the options page
and click **Grant access to all** once.

**I removed a site, but a tab that was already open keeps playing at the chosen speed.**
Chrome does not unload a content script when the permission it was injected under is revoked —
the script stays in that page, with its listeners, until the page navigates. The extension now
handles this itself: the service worker publishes the active sites to `chrome.storage.local`, and
a frame that is no longer covered stops, releases its videos, and puts their speed back to 1×. A
tab that was open from *before this version was installed* is still running the old script, which
has no such logic; reload it once.

**I removed a site, but the popup still shows a slider on it.**
That is the popup's own UI, not a leftover of the removed site. The slider is always on screen
because the speed is one global setting, but on a site the extension may not touch it is greyed
out and disabled, and the status line says so. Nothing is cached and **no browser restart is
needed**: removing a site revokes the permission and re-registers the content scripts
immediately, so the next page load on that site runs nothing. If the slider there is still
*usable* rather than greyed out, that is a bug — the extension was not reloaded after an update,
so press the reload arrow on its card in `chrome://extensions`.

**I enabled the site but the video still ignores the slider.**
The video is probably an embed. Open the popup and look at the list: the row with ▶ against it
is the origin actually playing, and if it has an **Enable** button it is not allowed yet.
Enabling the page's own origin does nothing for a player on another origin — see
[Embedded players](#embedded-players).

**The popup says "No video on this tab yet."**
Playback hasn't created the `<video>` element yet, or you are on a browse page rather than a
player page. Start a title; the speed applies on its own.

**I granted a site and nothing happens.**
Reload the page. A tab that was open before the site was granted is still running without the
content script; the popup's **Reload page** button does exactly this.

**The popup closed when I clicked "Enable on …".**
That is Chrome: it dismisses the popup to show its own permission prompt. Accept the prompt and
click the extension icon again.

**"Add" or "Grant" in the options page does nothing, or reports that Chrome refused the request.**
`chrome://extensions` embeds the options page in a frame, and Chrome can refuse a permission
prompt raised from inside it. The page then offers **Open this page in a tab**; granting from
there works. You can also grant from the popup while on the site.

**The popup says "Could not reach this tab."**
Chrome refused to inject into the page — usually because the extension was reloaded while the tab
stayed open. Reload the tab.

**Speed snaps back to 1× mid-playback.**
The player replaced the media source and the re-apply didn't catch it. Reopen the popup and nudge
the slider. If it happens consistently at a particular moment, add the relevant media event to
`REAPPLY_EVENTS` in [content.js](content.js).

**A site is granted but still does nothing.**
Check the extension's card in `chrome://extensions` for an error from the service worker, and
press the reload arrow — that re-runs the registration. The site also has to be on the list;
a site granted in Chrome's own UI is added to the list the next time the worker runs.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by any streaming provider. Trademarks referenced in
configuration are the property of their respective owners. The extension only changes the playback
rate of a `<video>` element through the standard browser API; it does not touch digital rights
management, download or redistribute content, or alter anything server-side.

## License

MIT — do whatever you like with it. See [LICENSE](LICENSE) for the full text.
