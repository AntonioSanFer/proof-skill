---
name: proof
description: Capture proof that the feature(s) just implemented actually work — screenshots plus a video of the flow, recorded from a real browser (or a single desktop window). Use when the user types /proof, or asks for screenshots, a recording, a video or evidence of a change ("prove it works", "show me it working", "captures for the PR"). For a polished, slow, marketing-style video use the proof-demo skill instead.
argument-hint: "[demo]"
allowed-tools: Bash(node *proofkit.mjs*) Bash(node *record-window.mjs*) Bash(npm install*) Read Write(.proof/**) Edit(.proof/**)
---

# /proof

Goal: honest evidence. Screenshots of each key state plus one video of the whole flow, made by driving the real app. If the feature is broken, the proof must show that — never stage a pass.

Arguments: `$ARGUMENTS`. **If that is `demo` (the user typed `/proof demo`), stop here and follow `${CLAUDE_SKILL_DIR}/../proof-demo/SKILL.md` instead.**

Don't ask the user what to prove: work it out from the conversation and the diff. Only ask if the feature can't be reached (e.g. it needs credentials you can't find in `.env`, seeds or the README).

Everything runs through `${CLAUDE_SKILL_DIR}/scripts/proofkit.mjs` (the skill directory is called `<skill>` below). It drives Chrome with Playwright, records the page with Playwright's own screencast (just the page, not the screen), and annotates every action with an animated pointer and an action label.

## Steps

1. **Decide what to prove.** From the conversation (and `git diff` if it's a repo), list each feature or fix you changed. For each one write down: start URL, the user steps, and the visible result that proves it works. One flow can cover several features; use `chapter()` to separate them.
2. **Get the app running.** If it is a local app and nothing listens on its port, start the dev server in the background and wait until the URL answers. Find the port in `package.json`/the dev config. Check that the URL serves *your* app (e.g. `curl -s <url> | grep <something from the app>`): another process can hold the same port on IPv6, so if `localhost` reaches the wrong app, use `http://127.0.0.1:<port>`. Stop only the server you started when done. If the page needs login, do it inside the flow.
3. **First run only:** if `${CLAUDE_SKILL_DIR}/node_modules` is missing, run `npm install` there. `ffmpeg` must be on PATH (without it you get a `.webm` instead of `.mp4`).
4. **Write the flow** to `.proof/flows/<slug>.mjs` in the project (create the folder; keeping the flow means it can be re-run later):

   ```js
   export const config = { url: 'http://localhost:3000/settings' }; // optional: viewport: { width, height }
   export default async ({ page, click, type, hover, scroll, shot, chapter, pause }) => {
     await chapter('Dark mode toggle');            // title card in the video
     await click(page.getByRole('switch', { name: 'Dark mode' }));
     await page.locator('html.dark').waitFor();    // assert the result, don't just sleep
     await shot('dark-mode-on');                   // -> NN-dark-mode-on.png
   };
   ```

   Helpers (a `target` is a selector string or a Playwright locator; the first match is used):

   | helper | does |
   |---|---|
   | `click(target, opts?)` / `hover(target)` | Playwright click/hover; the video shows the pointer and an action label |
   | `type(target, text)` | replaces the field's value |
| `press(key)` | presses a key, e.g. `'Enter'` |
   | `scroll(target \| pixels)` | smooth-scrolls to the element, or by N px |
   | `shot(name, opts?)` | saves `NN-name.png` (opts go to `page.screenshot`, e.g. `{ fullPage: true }`); the pointer is hidden in screenshots |
   | `chapter(title, description?)` | title card in the video (~1.2 s) |
   | `pause(ms = 1000)` | waits, so a state stays on screen in the video |

   - `page` is a normal Playwright page: use it for navigation, waits and checks the helpers don't cover. There is no `expect`; assert with `locator.waitFor()` or `if (!cond) throw new Error('...')`.
   - Take a `shot()` at every state a reviewer would want to see, and **wait for the expected result before each shot** so a failure throws instead of producing a misleading picture. Wait for what the picture must show: an element can be in the DOM before its image, spinner or animation has rendered (`await page.waitForLoadState('networkidle')` or wait on the visible text/state helps).
   - Re-running overwrites the files in `--out`.

5. **Run it** from the project root:

   ```
   node "${CLAUDE_SKILL_DIR}/scripts/proofkit.mjs" .proof/flows/<slug>.mjs --out .proof/<slug>
   ```

   Add `--headed` to watch it. It prints JSON with `ok`, `error`, `screenshots`, `video` and `sheet` (a 48-frame contact sheet of the video; Read it to check the video without playing it). On a failure it still saves the video so far and an `error.png`, and exits with code 1.
6. **Check the evidence yourself.** Read every screenshot and confirm it shows the claimed result. If the flow failed, decide whether the flow is wrong (fix it and re-run) or the feature is broken (say so, and keep the failing proof).
7. **Report.** One line per feature: what it proves → screenshot path(s), plus the video path. If you have a tool to send files to the user (e.g. SendUserFile), send the screenshots and the video. If this is a git repo and `.gitignore` doesn't cover `.proof/`, add it (and mention it).

## Not a browser app?

For a desktop app, Electron window, or anything Playwright cannot drive, record that single window with ffmpeg:

```
node "${CLAUDE_SKILL_DIR}/scripts/record-window.mjs" --list                      # exact window titles
node "${CLAUDE_SKILL_DIR}/scripts/record-window.mjs" --title "<exact title>" --out .proof/<slug>/window.mp4 --seconds 60
```

Run it in the background, do the interaction, then stop it early by creating the file `<out>.stop` (e.g. `touch .proof/<slug>/window.mp4.stop`). On Windows with ffmpeg 8+ it captures only that window even if it is covered (it records nothing while the window is minimized). Older ffmpeg on Windows, and Linux, grab the window's screen area, so keep it visible. macOS records the whole screen.
