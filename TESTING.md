# Testing SelariKru

SelariKru plans and runs AI coding work. Every AI step goes through **Firebase AI Logic** in the browser, either to **Gemini Nano on your device** or to **Gemini in the cloud**. Each task has a route that decides which, and the app records where every call actually ran. A local runner applies and verifies changes with no model.

There are two ways to try it. The hosted demo needs only a browser. The local stack needs Node, pnpm and Docker.

## 1. The hosted demo

The hosted demo is the app on **demo data**. It shows a fixed, simulated project, and every screen carries a **Demo data** label. Nothing in it counts as evidence. It has no server of its own: no control API and no sign-in.

The **AI calls are real.** The Assistant, the Project Manager, the task agents and the onboarding guide all call Firebase AI Logic:

- the device route uses **Gemini Nano** in Chrome, on your machine;
- the cloud route uses **Gemini** through Firebase, protected by App Check (reCAPTCHA Enterprise).

Routes, locks, fallback and the record of where each call ran work as they do with live data.

Some things to know before you start:

- **Cloud calls are capped per tab.** The top bar shows *Cloud calls left in this demo: N* (40 per tab). This protects the free-tier quota for everyone judging. When the count reaches 0, a step that needs the cloud pauses in **Action items › Paused AI work**. From there you can move it to your device or drop it. Calls on your device are not counted.
- **Debug › Go offline** simulates losing the connection. Your browser's own network is not changed.
- **Start the tour** (top bar) is a six-step walk through the story: a brief drafted on the device, a large task planned in the cloud, a restricted task locked to the device, a step that waits offline and is sent after reconnecting, the **AI calls** view (Boards › AI calls), and the Project Manager. The tour is offered once on your first visit.

### Getting Gemini Nano in Chrome

On-device calls need desktop Chrome with the built-in Prompt API (Gemini Nano). Google's guide covers the requirements: <https://developer.chrome.com/docs/ai/get-started>. In short:

1. Use a recent desktop Chrome on a machine that meets the guide's disk, memory and GPU requirements.
2. If the API is not on by default in your version, enable the Prompt API and the on-device model in `chrome://flags`, as the guide describes, then relaunch Chrome.
3. For the **Gemma 4** on-device model, enable `chrome://flags/#gemma4-for-built-in-ai` and relaunch. We tested with Chrome 157. Without the flag, Chrome serves its default Nano model, and the app works the same way.
4. Open `chrome://on-device-internals` to see the model's state. The first use may start a download. The app also offers to download the model where Chrome allows it.

**Without Nano**, the app says so in one calm banner when it first loads, and lists what each route will do:

- **Local first** steps run in the cloud instead. They are labelled as a **fallback**, in the step's result and in AI calls.
- **Cloud first** and **Cloud only** steps run in the cloud as usual.
- **Local only** steps, and every task locked by **restricted** data, are **blocked**. They wait for Nano and are never sent to the cloud.

## 2. The full local stack

You need Node 24, pnpm 9 and Docker. Copy `.env.example` to `.env` (repository root), and `apps/control-web/.env.example` to `apps/control-web/.env.local`. Each file lists the variable **names** only. Fill in your own values, and never commit them.

**From any terminal:** `npx github:0xhaz/SelariKru`. It clones the repository into `./SelariKru`, installs it, and on the first run asks you to paste your Firebase web config (Firebase console › Project settings › Your apps) and App Check site key. No Firebase project yet? Press Enter to skip: SelariKru still starts, and only the AI calls wait for the config (see [Your own Firebase project](#your-own-firebase-project)). It writes the two env files and sets up a local Feedback Board project (a git repository under `.local/starter/`, with GitHub off). Then it runs `pnpm start`. Sign in with `owner@selarikru.invalid` / `real-run-local-only-password` (Auth Emulator only). Run it again from the same folder to start next time.

**One command, in a checkout.** After `pnpm install`, `pnpm start` checks your machine, then starts everything: Postgres, the Auth Emulator, the control API, the web app and the local runner. Then it opens Chrome at http://127.0.0.1:5173. On the first start with `SELARIKRU_SOURCE_REPO` set, it pairs the local runner with the stack by itself (loopback only, using the seeded emulator owner). `pnpm start --check` runs only the checks, and lists anything to fix. Ctrl+C stops everything. The optional settings are at the end of `.env.example`.

```sh
git clone https://github.com/0xhaz/SelariKru.git
cd SelariKru
pnpm install
pnpm start
```

To start the parts one at a time instead:

```sh
pnpm install

# Demo data in the browser, with a stand-in model (no network, no Firebase):
pnpm --filter @selarikru/control-web dev
# then open http://127.0.0.1:5173/?demo

# The local stack: Postgres, migrations, the Firebase Auth Emulator and the control API.
pnpm db:up
pnpm dev:demo      # stack + a seeded demo account, project and run + the web app
pnpm dev:real      # stack + a real run against a local checkout (see .env.example)
```

AI calls in the local stack need your own Firebase project's web config. Set the `VITE_FIREBASE_*` values, plus `VITE_RECAPTCHA_SITE_KEY` for App Check, in `apps/control-web/.env.local`.

### Your own Firebase project

The local stack starts without one, but its AI calls need one. Setting it up takes about five minutes, all on the free Spark plan:

1. In the [Firebase console](https://console.firebase.google.com), create a project.
2. Open **AI Logic** and click **Get started** with the **Gemini Developer API**.
3. Open **Project settings › General › Your apps** and add a **web app**. Copy its `firebaseConfig` object: that is what `npx github:0xhaz/SelariKru` asks you to paste. By hand, its six values go in the `VITE_FIREBASE_*` lines of `apps/control-web/.env.local`.
4. Open **App Check**, register the web app with **reCAPTCHA Enterprise** (create a key that allows `localhost` and `127.0.0.1`), and copy the site key into `VITE_RECAPTCHA_SITE_KEY`.
5. Start SelariKru and open Chrome's console. In local development, App Check prints a **debug token** there. Add it in **App Check › Apps › Manage debug tokens**. Keep it private: never paste it into chat, an issue or a commit.

Restart `pnpm start` after changing `.env.local`.

The brief's **Check in the cloud** and the PM's **Research the web** use Grounding with Google Search, which some free Gemini tiers do not include (the call is refused with HTTP 429). Leave **Settings › Workflow › Google Search (web research)** off and use **Check without web search** instead.

To build and preview the hosted demo locally, set the same variables in the environment, then run:

```sh
pnpm --filter @selarikru/control-web build:hosted
pnpm --filter @selarikru/control-web exec vite preview --outDir dist-hosted
```

The build fails if any `VITE_FIREBASE_*` variable or the reCAPTCHA site key is missing. It also refuses to build with an App Check debug token set.

### Deploying the hosted demo

The hosted demo is a static site on **Firebase Hosting** (the free Spark plan is enough). It has no server and no database. Set up the project in the Firebase and Google Cloud consoles first:

1. Create a **reCAPTCHA Enterprise** key for your Hosting domains (`<project>.web.app` and `<project>.firebaseapp.com`), and register it as the web app's **App Check** provider.
2. **Enforce App Check** for Firebase AI Logic, and set a per-user rate limit for AI Logic.
3. Restrict the web **API key** to your Hosting domains and the APIs the app uses. Use a key that has never been committed.

Then run:

```sh
pnpm check:hosted                 # builds dist-hosted and runs the pre-deploy check
firebase deploy --only hosting    # runs the same build and check first; a failed check uploads nothing
```

The pre-deploy check ([tools/deploy/check-hosted.mjs](tools/deploy/check-hosted.mjs)) fails if the build has:

- a benchmark or test page, or source maps;
- no CSP;
- an internal file reference or local path;
- a token or private key;
- no reCAPTCHA site key;
- a Firebase API key that appears anywhere in git history.

It never prints a key.

### Automated tests

```sh
pnpm typecheck
pnpm --filter @selarikru/control-web exec vitest run
pnpm --filter @selarikru/control-web exec playwright test   # starts its own dev server on port 5174 (set PW_PORT to change it)
```

No test needs a key: the build tests use placeholder values.
