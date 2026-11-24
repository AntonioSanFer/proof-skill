# proof-skill

Two Claude Code skills that produce visual proof of a change:

- **`/proof`**: screenshots plus a raw video of the flow, with Playwright's own animated pointer and action labels. This is evidence: if the feature is broken, the proof shows it.
- **`/proof-demo`**: the same flow made pretty. It runs slowly, with an eased cursor and click ripples, types at human speed, adds title cards and an auto-zoom camera that follows the action, and frames the page as a 1080p window on a gradient.

Both use one engine, `skills/proof/scripts/proofkit.mjs`. Claude writes a small flow file and the engine runs it in either mode:

```js
export const config = { url: 'https://www.saucedemo.com/', title: 'Checkout in 30 seconds' };
export default async ({ page, click, type, hover, scroll, shot, chapter, pause }) => {
  await type('#user-name', 'standard_user');
  await click('#login-button');
  await shot('inventory');
};
```

```
node skills/proof/scripts/proofkit.mjs examples/saucedemo-checkout.mjs            # proof
node skills/proof/scripts/proofkit.mjs examples/saucedemo-checkout.mjs --demo     # demo
```

For non-browser apps, `skills/proof/scripts/record-window.mjs` records one desktop window from the command line. It uses ffmpeg `gfxcapture` on Windows (ffmpeg 8+), which works even when the window is covered, and `x11grab` on Linux.

## Install

You need Node 18+, Google Chrome and `ffmpeg` on PATH. Playwright is installed automatically the first time a skill runs.

**As a plugin** (inside Claude Code):

```
/plugin marketplace add AntonioSanFer/proof-skill
/plugin install proof@proof-skill
```

Plugin skills are namespaced, so the commands are `/proof:proof` and `/proof:proof-demo`. Asking in plain words ("make a demo video of this") works too.

**As plain skills** (gives you the short `/proof` and `/proof-demo`):

```
git clone https://github.com/AntonioSanFer/proof-skill
cd proof-skill/skills/proof && npm install && cd ../..

# macOS / Linux
ln -s "$PWD/skills/proof" ~/.claude/skills/proof && ln -s "$PWD/skills/proof-demo" ~/.claude/skills/proof-demo
# Windows (cmd)
mklink /J %USERPROFILE%\.claude\skills\proof      %CD%\skills\proof
mklink /J %USERPROFILE%\.claude\skills\proof-demo %CD%\skills\proof-demo
```

Then, in any project, right after finishing a feature: `/proof-demo` (or `/proof demo`), or `/proof` for plain evidence. Output goes to `.proof/` in that project. The skills pre-approve running the kit, so there are no permission prompts for it.

Developed and tested on Windows. The browser skills should work on macOS and Linux too; `record-window.mjs` is untested there (on macOS it records the whole screen).

## Why built this way

- **Recording**: Playwright 1.59+ has `page.screencast` built in. It records just the page (no screen recorder, no window focus) and offers `showActions` (animated pointer + labels), `showChapter` and `showOverlay`. `/proof` uses it as it is.
- **Demo cursor**: the cursor is injected into the page and driven by real mouse events moved along an eased, slightly curved path. That makes it frame-perfect with the page's own animations and fires hover states on the way. Post-hoc overlays (e.g. `playwright-recast`, which was tried) drifted out of sync with clicks and trimmed the video.
- **Sharp zoom**: headless screencast frames are in CSS pixels and ignore Playwright's emulated `deviceScaleFactor`. A bigger viewport would change the site's layout. Instead demo mode launches Chrome with `--force-device-scale-factor=2`: same 1600×900 layout, 3200×1800 frames.
- **Camera + frame**: an ffmpeg `zoompan` with expressions generated from the recorded action timestamps (smoothstep in/out, panning between nearby actions). The window frame is HTML rendered by the same browser, then composited by ffmpeg.
- **Wide shot on screen changes**: before and after each click/keypress the demo takes a cheap fingerprint of the screen (URL, visible text lines, open dialogs). If it changed drastically, the camera zooms out and holds the full screen for 2 s, so new screens are never only seen zoomed in.
- **Text stays visible**: while typing, the camera follows the caret (measured with a hidden copy of the field) and the pointer steps aside under the field. On hover, the arrow's tip sits on the element's bottom edge so the arrow hangs below the text.
- **Windows window capture**: `gdigrab title=` records black frames for GPU-composited windows (Chrome, UWP). `gfxcapture` (Windows Graphics Capture) does not have that problem.
