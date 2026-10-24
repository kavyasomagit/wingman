# How we used Kiro to build Iris

Iris was built in one afternoon: from an empty repo at 16:15 to a working phone app, Node proxy, hands-free Live mode, and web version. All of it was built with Kiro. This write-up says what we used, how, and what difference it made. It also says plainly what we didn't use.

Everything referenced here is in the repo:
- Spec: `.kiro/specs/iris/`
- Steering: `.kiro/steering/`
- Hooks: `.kiro/hooks/`
- Tests: `app/src/core/__tests__/`

## 1. Kiro tools used

**Kiro IDE, in Autopilot mode, for the whole build.** One long agent session did the planning, scaffolding, coding, running servers, reading logs, and debugging. We didn't use the Kiro CLI, Web, or Crew. With a 2-hour target, one tool kept all the context (spec, code, live logs) in a single conversation.

Built-in IDE capabilities that mattered most:

| Capability | What it did for Iris |
|---|---|
| Shell + background processes | Ran the Node proxy as a background process and read its log on demand. That's how Kiro analysed our live phone tests: it found the 503 overloads, the 19-second frames, the rate-limit error, and the Live session restarting after every turn. |
| Reading type definitions | Kiro read `node_modules/expo-*/build/*.d.ts` before writing Expo code. Expo SDK 58 was newer than its training data. |
| Web search | Found current Gemini model names and verified the WHO statistic in our description. |
| Artifacts | Produced the submission checklist, the 2-slide deck (built with pptxgenjs, previewed as images, and re-laid-out after Kiro saw bullet and label problems), and this document. |

## 2. Spec-driven development

### How the spec is structured

Our first prompt described the product and the five-agent architecture and asked Kiro to "plan this spec-first (requirements → design → tasks)". Kiro wrote three files before writing any code:

- **`requirements.md`:** R1–R10 in EARS style ("WHEN an object is seen again, its index entry SHALL be replaced by the newer sighting"). It also has a single primary demo flow that must work end to end, plus an explicit out-of-scope list for v2. The rules that matter most for blind users are requirements with IDs: R6.3 (cooldown), R7.2/R7.3 (alerts interrupt answers, which then resume), and R8 (never say "safe").
- **`design.md`:** the architecture diagram, the component list, error handling, and one key decision with its trade-off: **one Gemini vision call per frame, shared by Guardian and Scene Logger**. It halves API usage and keeps us inside free-tier rate limits, while the agents stay separate in code. The design also recorded an assumption: "Expo Go can't stream audio in real time".
- **`tasks.md`:** tasks ordered for a 2-hour build, each traced to requirement IDs. Core logic and tests come before the UI, so the riskiest rules were proven first.

### How it changed the process

- **The tests came from the spec.** The user asked for tests of three rules, and the requirements turned each into something testable. The test names cite the IDs, for example `SpeechQueue: hazards always interrupt other speech (R7)`. Those tests passed before any UI existed, and they never broke through all the later changes.
- **The spec decided where the code goes.** The design required core logic to be pure TypeScript (no React Native imports). That paid off later: the web version reuses `app/src/core` unchanged, with the same tests.
- **The spec changed when reality did.** Live testing overturned two assumptions:
  1. **`gemini-2.5-flash` was retired.** Kiro listed the models available to our key and timed them on image input. It rejected 3.7 and 3.8 Flash because they took over 30 s.
  2. **Expo Go can stream audio after all.** While checking expo-audio's type definitions, Kiro found the new SDK 58 `AudioStream` API. That overturned the design's "Expo Go can't stream audio" assumption. Before building anything on it, Kiro ran two quick checks:
     - an on-device microphone test that posted its results to our server log (38 buffers of about 100 ms, 16 kHz, real audio)
     - a laptop test of the Gemini Live API, which found that text-only replies are rejected (error 1007), so Iris speaks the reply's transcript instead

  Hands-free Live mode moved into v1. `tasks.md` now has a "Phase 2: changes driven by live testing" section that records why each change happened.

### Spec-driven vs. vibe coding

We did both, on purpose:
- **The spec** for the parts that had to be right: the safety rules, the speech queue, the memory semantics, the agent boundaries.
- **Conversational iteration** for exploration: model benchmarks, the Live API feasibility tests, reading logs, slide layout.

The difference showed in what broke. The spec-backed core never regressed. The vibe-coded exploration produced the useful surprises, and the spec then absorbed them as tasks with reasons attached. With a 2-hour clock we skipped stopping for approval between requirements, design, and tasks. Kiro wrote all three files in one go and started building.

## 3. Property-based testing

After the example-based tests, we added fast-check properties for the same requirements (`properties.test.ts`, 1,900 random scenarios per test run):

| Requirement | Property |
|---|---|
| R7 priority queue | For any interleaving of answers, alerts, and finished utterances: right after `alert()`, an alert is playing. Every alert plays exactly once, in order. Every answer sentence plays, in order. Only an interrupted sentence may repeat. |
| R6.3 cooldown | For any stream of hazards over time, the same hazard never gets through twice within 15 s unless its urgency increased. |
| R2.3 / R5.3 where-is | For sightings arriving in any order, including out-of-order late frames and name variants ("my keys", "key"), `whereIs` returns the newest sighting. |
| R8 safety | For any mix of sentences, the output never contains "safe to cross", "all clear", or "cross safely". Filtering twice equals filtering once. |

**PBT found a real bug that our unit tests missed.** The idempotence property failed on its first run. fast-check shrank it to `"You can cross safely now. There is a crosswalk ahead."`:
- Filtering once gave the disclaimer: "I can't judge whether it's safe. Please rely on your cane…".
- Filtering that output again duplicated the "Please rely on your cane…" sentence.

The same thing happens in practice when the model already gives the cane reminder itself, so Iris would have repeated it. Our unit tests only checked single examples, so they never caught it. We fixed `sanitizeSpeech` so it keeps the disclaimer's own sentences and never adds them twice. All 29 tests pass.

## 4. Steering docs

Two steering files capture what this build taught us, so future Kiro sessions start with it:

- **`iris-product.md`** (`inclusion: always`): the rules that must never break.
  - Never say "safe", and every spoken string goes through `sanitizeSpeech`.
  - Agents never call each other.
  - All speech goes through `SpeechQueue`.
  - Never play Live audio directly.
  - The API key never goes in `app/`, `web/src/`, or anything prefixed `EXPO_PUBLIC_`.
  - Core logic stays pure.
  - Every rule change gets a unit test plus a property.
  - Run the tests and typecheck before saying a task is done.
- **`expo-gemini-tech.md`** (`inclusion: fileMatch` on `app/**`, `server/**`, `web/api/**`): **verified facts that contradict model training data.** Examples:
  - `gemini-2.5-flash` returns 404 for new users.
  - `gemini-3.8-live` rejects `thinkingLevel: minimal`.
  - Live text-only replies are rejected; use the reply's transcript.
  - The free tier allows 500 requests per day per model, and the fallback model must differ from the primary.
  - `useAudioStream` works in Expo Go.
  - `say --data-format=aac` writes silent audio files.

The biggest lesson: steering is most valuable for **facts the model would otherwise get confidently wrong**, not for style rules. Almost every bug in this build came from stale assumptions: a retired model, an outdated idea of what Expo Go can do, a fallback that pointed at the model that had just failed. The tech steering file applies only to the matching folders, so it adds no noise when we edit docs or slides.

## 5. Agent hooks

Three hooks in `.kiro/hooks/`, each tested by running its command directly:

| Hook | Trigger | Why |
|---|---|---|
| `core-tests-on-save` | PostFileSave on `app/src/core/**`, `live.ts`, `agents.ts` (and web copies) | Runs the 29 unit and property tests on every save of safety-critical logic. Result: `29 passed` in about 0.3 s, so it doesn't slow editing. |
| `server-syntax-check` | PostFileSave on `server/*.mjs`, `web/api/**/*.js` | `node --check` on the proxy and Vercel functions. A syntax error in the server would only show up after a restart, which could be mid-demo. |
| `block-api-key-writes` | PreToolUse on `fs_write`, `str_replace`, `fs_append` | Exits with code 2 (blocks the write) if the edit contains a Google API key. Tested: an edit with a key is blocked with an explanation; a clean edit passes. |

The last hook comes from a real incident. During testing, the Gemini key was pasted into `app/.env`. Kiro noticed, moved it to `server/.env`, and kept it out of git. The hook turns that one-time catch into a guarantee.

We added the steering docs and hooks near the end of the build, after the lessons above were learned. They protect future work on Iris rather than having shaped the first two hours.

## 6. MCP and Powers

**We didn't use MCP servers or Kiro Powers in this build.** Kiro's built-in tools (shell, background processes, web search and fetch, file tools, artifacts) covered what we needed. The two places where an integration would have helped:

- **GitHub MCP:** the GitHub CLI wasn't installed, so we pushed with plain `git`. MCP would have let Kiro create the repo, a release, and the submission links directly.
- **Vercel deployment:** the last step is the only one Kiro couldn't do, because it needs our Vercel login. A Vercel integration would have let Kiro deploy `web/` and check the live site's server functions itself.

These are our next steps rather than claims.

## 7. What worked best

1. **Ask for the spec first, then let live evidence revise it.** The requirement IDs gave every test, commit, and change a reason that judges can trace.
2. **Let the agent run and read the real system.** The best fixes came from Kiro reading our server log after a phone test: the fallback model, stale-hazard filtering, cutting out furniture warnings, and moving frames to a model with remaining quota.
3. **Test risky platform assumptions before building on them.** A 5-minute on-device check plus a laptop Live API test turned "maybe in v2" into a hands-free feature shipped the same day.
4. **Write down what was learned so it isn't learned twice.** Steering for facts, hooks for guarantees, properties for "for all inputs" rules.
