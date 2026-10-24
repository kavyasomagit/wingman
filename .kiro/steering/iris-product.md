---
inclusion: always
---

# Iris: product and safety rules (always apply)

Iris is a wearable AI companion for blind and low-vision people. Every change must preserve these rules.

## Safety (non-negotiable)
- Iris must NEVER say anything is "safe", "clear", or "safe to cross". Every spoken string goes through `sanitizeSpeech` (`app/src/core/safety.ts`, mirrored in `web/src/core/safety.ts`). New prompts must include the shared `SAFETY_RULES` block.
- Iris supplements a cane or guide dog and never replaces them. Never write copy suggesting otherwise.
- Hazard warnings: at most 8 words, directional ("Step down ahead."), only for the walking path. A late warning is worse than none: drop hazards from frames older than `Guardian.maxFrameAgeMs`.

## Architecture invariants
- Agents (Scene Logger, Guardian, Short-Term Memory, Long-Term Memory, Communicator) never call each other. They communicate only via `MemoryStore` and `SpeechQueue`.
- ALL speech goes through the single `SpeechQueue`. Guardian uses `queue.alert()`, everything else uses `queue.say()`. Never call `expo-speech` or `speechSynthesis` directly from an agent.
- Never play Gemini Live audio directly; speak its transcript through the queue so alerts can interrupt it.
- One vision call per frame (`/api/perceive`), shared by Guardian and Scene Logger, to stay inside rate limits.
- The Gemini API key lives only in `server/.env` or Vercel env vars. Never in `app/`, `web/src/`, or anything prefixed `EXPO_PUBLIC_`.

## Working rules
- Core logic in `*/src/core/` must stay pure TypeScript (no React Native or DOM imports) so it stays testable. `app/src/core` is the source of truth; copy changes to `web/src/core`.
- Every change to core logic needs tests: a unit test for the example, and a fast-check property in `__tests__/properties.test.ts` when the rule is "for all inputs".
- Before saying a task is done, run `npm test` and `npx tsc --noEmit` in `app/` (and `web/` if touched), plus `node --check` on server files.
- Requirements live in `.kiro/specs/iris/requirements.md` (R1–R10). Reference requirement IDs in tests and commit messages.
