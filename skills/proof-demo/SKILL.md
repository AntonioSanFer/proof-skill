---
name: proof-demo
description: Make a polished demo video of the feature(s) just implemented — slow, cinematic walkthrough with an eased cursor that glides to each click, click ripples, human-speed typing, title cards, auto-zoom that follows the action, and a framed 1080p window on a gradient background. Use when the user types /proof-demo or "/proof demo", or asks for a demo, showcase, product or marketing video of a change. For plain evidence (screenshots + raw recording) use the proof skill instead.
allowed-tools: Bash(node *proofkit.mjs*) Bash(node *record-window.mjs*) Bash(npm install*) Read Write(.proof/**) Edit(.proof/**)
---

# /proof-demo

Same engine as `/proof` (`proofkit.mjs`, which lives in the sibling `proof` skill: `${CLAUDE_SKILL_DIR}/../proof/scripts/proofkit.mjs`, called `<kit>` below), run with `--demo`. In demo mode:

- Playwright's own screencast records the page with a 1600×900 layout captured at 2× (3200×1800 frames, Chrome's real scale factor forced), so all page animations, hovers and transitions are captured as they really render and zoomed-in shots stay sharp. Screenshots in demo mode are 2× too.
- A cursor is injected into the page. Each helper moves the real mouse along a slightly curved path with ease-in-out timing, so the cursor glides, hover states fire on the way, and the click shows a ripple.
- Typing is per character at human speed; there are pauses after every action.
- After recording, ffmpeg adds a camera that zooms into each action and pans between nearby actions (smooth in and out), then frames the page in a window with a title bar and URL on a gradient, as `demo.mp4` (1920×1080, H.264).

## Steps

Run it end to end without asking the user anything: work out the story from the conversation and the diff. Only ask if the feature can't be reached (e.g. it needs credentials you can't find in `.env`, seeds or the README).


1. **Pick the story.** From the conversation (and `git diff` if it's a repo), decide which feature(s) to show and the shortest flow that shows them off: 20–60 seconds, one chapter per feature, ending on the result.
2. **Get the app running** (start the dev server in the background if nothing answers). Find the port in `package.json`/the dev config. Check that the URL serves *your* app (e.g. `curl -s <url> | grep <something from the app>`): another process can hold the same port on IPv6, so if `localhost` reaches the wrong app, use `http://127.0.0.1:<port>`. Stop only the server you started when done. The first time, run `npm install` in `${CLAUDE_SKILL_DIR}/../proof` if its `node_modules` is missing. `ffmpeg` must be on PATH.
3. **Write the flow** to `.proof/flows/<slug>.mjs` (create the folder). The same file works with `/proof`, so if one already exists, reuse it.

   ```js
   export const config = {
     url: 'http://localhost:3000/',
     title: 'Saved searches',                 // opening title card
     subtitle: 'Find it again in one click',  // optional
     // label: 'app.acme.com',  zoom: 1.5 (false to disable),  overview: 2000 (ms, false to disable),  viewport: { width: 1600, height: 900 }
   };
   export default async ({ page, click, type, press, hover, scroll, shot, chapter, overview, pause }) => {
     await chapter('Save a search');
     await type('input[name=q]', 'red shoes');
     await click(page.getByRole('button', { name: 'Save search' }));
     await page.getByText('Search saved').waitFor();
     await pause(1200);                       // let the viewer read the result
   };
   ```

   Helpers (`target` = selector string or Playwright locator): `click(target)`, `type(target, text)` (replaces the field's value, typing per character), `press(key)`, `hover(target)`, `scroll(target | pixels)`, `shot(name)`, `chapter(title, description?)`, `overview(ms = 2000)` (zoom out and hold the full screen), `pause(ms = 1000)`. `page` is a normal Playwright page.

   How the camera behaves, so you can direct it:
   - It zooms in (default 1.5×) as the cursor starts moving to a target, and frames a point between the target and the page centre so the context stays visible.
   - Actions less than 1.6 s apart stay zoomed and the camera pans between them. A longer gap, a `scroll()` or a `chapter()` zooms back out, and cards always show un-zoomed.
   - **Screen changes get a wide shot.** After every `click()`/`press()`, the kit checks whether the screen changed drastically: the URL changed (including SPA and hash routes), a dialog opened, or less than 60% of the visible text is still the same. If so, the camera zooms out and holds the whole new screen for 2 s (`config.overview`) before the next action. For a change it can't detect (a chart redraw, a canvas, an image swap), call `overview()` yourself after the action.
   - **Typing follows the caret.** `type()` aims at where the text starts, moves the pointer just below the field so it doesn't cover the text, and the camera tracks the caret as it moves (long inputs, multi-line textareas, contenteditable).
   - **`hover()` doesn't hide text.** On short, text-like elements the arrow's tip sits on the bottom edge, so the arrow hangs below the text while the hover state stays on.
   - To keep the camera on a result, `hover()` it right after the action. For narrow layouts (a 500 px column) set `zoom: 2`; for wide dashboards set `zoom: 1.3` or `false`.

   Rules for a good demo:
   - **Every interaction goes through a helper** (`click`, `type`, `press`, `hover`, `scroll`). Raw `page.click()` works but the cursor jumps instead of gliding and the camera does not follow it.
   - Use `hover()` on things worth pointing at before clicking them, and `pause()` after results appear.
   - Use `chapter(title, description)` between features; it shows a blurred title card and resets the zoom.
   - Wait for real results (`waitFor`) rather than fixed sleeps around network calls, so the pacing comes from the helpers, not from loading.
   - Skip login and setup screens that add nothing: authenticate before the story starts, or start on a URL past it.
4. **Run it** from the project root (takes about the flow's length plus ~15 s of rendering):

   ```
   node "${CLAUDE_SKILL_DIR}/../proof/scripts/proofkit.mjs" .proof/flows/<slug>.mjs --demo --out .proof/<slug>-demo
   ```

   It prints JSON. If `"ok"` is false the flow threw: the demo is **not** rendered (only `raw.webm` is kept), so read `error` and fix the flow. Don't pipe the output through `tail` and miss it.
5. **Watch it before you hand it over.** Read the `sheet` from the JSON (`.proof/<slug>-demo/sheet.png`, 48 frames spread over the whole video). Check the cursor lands on the right elements, the zoom keeps the action in frame, and the result is visible at the end. Tune the flow (pauses, hovers, `zoom`) and re-run if not.
6. **Wrap up.** If this is a git repo and `.gitignore` doesn't cover `.proof/`, add it. **Report** the path to `demo.mp4` (and the screenshots if you took any), with one line on what the video shows. If you have a tool to send files to the user (e.g. SendUserFile), send the video.
