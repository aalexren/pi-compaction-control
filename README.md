# pi-compaction-control

[![npm version](https://img.shields.io/npm/v/pi-compaction-control?logo=npm)](https://www.npmjs.com/package/pi-compaction-control)
[![npm license](https://img.shields.io/npm/l/pi-compaction-control)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/pi-compaction-control)](https://www.npmjs.com/package/pi-compaction-control)
[![GitHub Actions](https://github.com/aalexren/pi-compaction-control/actions/workflows/publish.yml/badge.svg)](https://github.com/aalexren/pi-compaction-control/actions/workflows/publish.yml)
[![GitHub release](https://img.shields.io/github/v/release/aalexren/pi-compaction-control?logo=github)](https://github.com/aalexren/pi-compaction-control/releases)
[![GitHub code size](https://img.shields.io/github/languages/code-size/aalexren/pi-compaction-control?logo=github)](https://github.com/aalexren/pi-compaction-control)
[![GitHub top language](https://img.shields.io/github/languages/top/aalexren/pi-compaction-control?logo=typescript)](https://github.com/aalexren/pi-compaction-control)

A single [Pi Coding Agent](https://github.com/earendil-works/pi) extension that gives you full control over conversation compaction: a **granular per-model hard cap** on context windows, and a **configurable compaction model**. Both read from Pi's own `settings.json`, so everything lives in one place — no extra config files, no separate package install.

**Zero token overhead.** The extension never makes LLM calls of its own: `contextCap` is a pure in-memory mutation of `model.contextWindow`, and `compactionModel` only re-routes the summariser that Pi runs anyway. No extra prompts, no extra requests, no hidden API calls.

What you get:

- Caps oversized context windows so auto-compaction fires earlier — at `cap − reserveTokens` instead of the model's native (often huge) window.
- Optionally picks a cheaper/faster model to run the compaction summary.
- Works out of the box with sensible defaults (256k cap, all models) — nothing to set if that's all you want.

---

## 🤔 Why

Bigger context windows are not better. Even 2026 frontier models degrade sharply past ~200K tokens: RULER and MRCR v2 benchmarks show them losing **30–60 percentage points** of multi-fact retrieval accuracy between 32K and 500K, on models that *advertise* a 1M-token window.

Pi's built-in compaction settings (`compaction.reserveTokens`, `compaction.keepRecentTokens`) control *how much* to keep and *how much room to leave*, but they can't cap the model's context window itself. On long-context models (1M-token Claude, 500K Grok, etc.) compaction only fires at `contextWindow - reserveTokens`, which is rarely what you want for day-to-day work.

This extension adds the missing piece: a client-side cap on `model.contextWindow`. It also lets you pick which model runs the compaction summariser, all configurable per-model.

| What it does | Without extension | With extension | Config |
| --- | --- | --- | --- |
| Reserve tokens for the reply | ✅ | ✅ | `compaction.reserveTokens` |
| Keep recent tokens verbatim | ✅ | ✅ | `compaction.keepRecentTokens` |
| Cap the context window | ❌ | ✅ | `contextCap` |
| Pick the summariser model | ❌ | ✅ | `compactionModel` |

> **Note:** `reserveTokens` and `keepRecentTokens` cannot be overridden by an extension: Pi's `prepareCompaction()` runs *before* the `session_before_compact` event and bakes them into the preparation. They must stay in `settings.json`.

---

## ⬇️ Install

### Option A — via your agent (recommended)

Paste this into your Pi agent — it runs the install for you:

```
install npm:pi-compaction-control
```

### Option B — from npm (manual)

```bash
pi install npm:pi-compaction-control
```

### Option C — global (manual)

Copy the package directory into Pi's global extensions directory:

```bash
cp -r pi-compaction-control ~/.pi/agent/extensions/
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. No `pi install` needed.

### Option D — from this repo as a pi package

```bash
pi install git:github.com/aalexren/pi-compaction-control
```

### Option E — project-local

```bash
cp -r pi-compaction-control .pi/extensions/
```

Project-local extensions load after project trust is granted.

After installing, **restart Pi** (or run `/reload`).

---

## ⚙️ Configure

All config lives in `~/.pi/agent/settings.json` (global) or `<project>/.pi/settings.json` (project overrides global, per top-level key).

### 1. Built-in compaction (Pi core)

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 32768,
    "keepRecentTokens": 30000
  }
}
```

### 2. `contextCap` — granular per-model hard cap

Caps every matching model's effective `contextWindow` so auto-compaction fires at `cap - reserveTokens` instead of the model's native window.

```jsonc
{
  "contextCap": {
    "cap": 256000,                       // default target contextWindow (tokens)
    "appliesOver": 256000,               // only cap models whose native window exceeds this
    "matchPatterns": ["*"],              // id-substring matchers (case-insensitive); ["*"] = all
    "models": {                          // per-model-id granular overrides (wins over patterns)
      "gpt-6-astra": 200000,
      "grok-4-6": 180000
    },
    "notify": true                       // notify on each cap applied
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `cap` | `256000` | Target `contextWindow` for pattern-matched models |
| `appliesOver` | `256000` | Only cap models whose native window exceeds this (ignored for per-model overrides) |
| `matchPatterns` | `["*"]` | id-substring matchers; `"*"` matches all |
| `models` | `{}` | Per-model-id granular caps. Always wins over pattern matching |
| `notify` | `true` | Show a notification when a model is capped |

**How matching works** (per model):

1. If `models[model.id]` is set → cap to that value (always, ignores `appliesOver`).
2. Else if `model.id` matches any `matchPatterns` → cap to `cap` only if `model.contextWindow > appliesOver`.
3. Else → leave unchanged.

Idempotent: models already at or below their target are skipped.

**Examples**

Cap everything at 256k:

```json
{ "contextCap": { "cap": 256000 } }
```

Only cap Anthropic models, leave others alone:

```json
{
  "contextCap": {
    "cap": 200000,
    "appliesOver": 200000,
    "matchPatterns": ["anthropic", "claude"]
  }
}
```

Cap one specific model, leave everything else:

```json
{
  "contextCap": {
    "matchPatterns": [],
    "models": { "gpt-6-astra": 200000 }
  }
}
```

### 3. `compactionModel` — which model runs the summariser

Follows Pi's `{ model, thinkingLevel }` convention.

```jsonc
{
  "compactionModel": {
    "model": "current",                  // "current"/"default"/unset → active conversation model
    "thinkingLevel": "low"               // optional: minimal|low|medium|high|xhigh|max
  }
}
```

| Value | Behavior |
| --- | --- |
| `"current"`, `"default"`, `"active"`, `""`, or unset | Pi's default — compact with the active conversation model. Extension only logs visibility. |
| `"provider/modelId"` | Resolve that model and run Pi's **native `compact()`** with it. Pi's own prompts, cut-point logic, file-operation tracking, and iterative summary updates are all preserved. |

When a specific model is configured, the extension:

1. Resolves it via `modelRegistry.find(provider, modelId)`.
2. Pulls auth via `modelRegistry.getApiKeyAndHeaders(model)`.
3. Calls Pi's exported `compact()` with the preparation, model, auth, and optional `thinkingLevel`.
4. Returns the `CompactionResult` from `session_before_compact`.

On any failure (model not found, auth error, `compact()` throws), control falls back to Pi's default (active model) — compaction never breaks.

**Example — use a cheaper/faster model for summaries:**

```json
{
  "compactionModel": {
    "model": "google/gemini-2.5-flash",
    "thinkingLevel": "low"
  }
}
```

---

## 📦 Built-in context settings (out of the box)

Pi already ships context/compaction controls in `settings.json` — you may not need this extension at all if these are enough. They work with zero install:

```jsonc
{
  "compaction": {
    "enabled": true,            // default: true — enable auto-compaction
    "reserveTokens": 32768,    // default: 16384 — tokens reserved for the LLM response
    "keepRecentTokens": 20000  // default: 20000 — recent tokens kept (not summarized)
  }
}
```

| Built-in key | Default | What it does |
| --- | --- | --- |
| `compaction.enabled` | `true` | Enable auto-compaction (disable with `false`; `/compact` still works manually) |
| `compaction.reserveTokens` | `16384` | Tokens to reserve for the LLM response — auto-compaction fires when `contextTokens > contextWindow - reserveTokens` |
| `compaction.keepRecentTokens` | `20000` | Recent tokens to keep verbatim (not summarized) |

Auto-compaction trigger (Pi core):

```text
contextTokens > contextWindow - reserveTokens
```

**What the built-in keys *cannot* do** (and why this extension exists):

- ❌ Cap the model's `contextWindow` itself — Pi uses the model's native window (e.g. 1,000,000 for long-context Claude), so compaction only fires near that native limit.
- ❌ Choose a different model for the compaction summariser — Pi always uses the active conversation model.

This extension adds exactly those two missing pieces. The built-in `compaction.*` keys continue to work alongside it (and are required — the extension can't override `reserveTokens`/`keepRecentTokens`).

---

## 🧮 How compaction now behaves

Four numbers decide when compaction fires, how much it keeps, and how big the summary can be:

```text
trigger        =  contextWindow − reserveTokens     ← when compaction fires
summaryBudget  =  min(0.8 × reserveTokens, maxOutput)  ← how big the summary can be
keepRecent     =  keepRecentTokens                   ← verbatim context kept

after compaction:  context ≈ summary + keepRecent   (summary REPLACES old context)
```

`0.8` is pi's factor (it reserves 20% of `reserveTokens` for the compaction prompt overhead). `maxOutput` is the summariser model's max output (provider-side, e.g. 8,192 for a small-output model, 192,000 for a big-output one).

With the defaults (`cap = 256000`, `reserve = 32768`, `keepRecent = 30000`, small-output summariser `maxOutput = 8192`):

```text
trigger       = 256000 − 32768   = 223232
summaryBudget = min(26214, 8192) = 8192   ← output is the bottleneck, not reserve
keepRecent    = 30000
after compact ≈ 8192 + 30000   = 38192   ← below 223232 ✓ (185K of headroom)
```

### The no-loop constraint

Compaction must leave context **below** the trigger, or it re-fires immediately in a loop:

```text
summary + keepRecent  <  trigger
summary + keepRecent  <  cap − reserve
```

Substituting the worst case (full summary budget):

```text
keepRecent  <  cap − reserve − summaryBudget
keepRecent  <  cap − reserve − min(0.8 × reserve, maxOutput)
```

This is a strict inequality — there is no fixed "safe margin". The headroom is whatever is left over; you just need the sum strictly below the trigger.

### Two regimes

Which term bottlenecks the summary depends on the model's `maxOutput`:

| Regime | When | summaryBudget | keepRecent must be < |
| --- | --- | --- | --- |
| Small-output model | `maxOutput ≤ 0.8 × reserve` | `maxOutput` | `cap − reserve − maxOutput` |
| Big-output model | `maxOutput > 0.8 × reserve` | `0.8 × reserve` | `cap − 1.8 × reserve` |

**Small-output model** (e.g. `maxOutput = 8192`): the output cap bottlenecks the summary, so `reserve` only affects the trigger — you can raise it freely without growing the summary. Lots of room for `keepRecent`.

**Big-output model** (e.g. 192K-output model): `reserve` bottlenecks the summary, so raising `reserve` is *doubly expensive* — it shrinks the trigger **and** grows the summary. `keepRecent` gets squeezed from both sides.

### Big-output model, cap = 200000, reserve = 100000

```text
trigger       = 200000 − 100000  = 100000
summaryBudget = min(80000, 192000) = 80000   ← reserve is the bottleneck
keepRecent    must be <  100000 − 80000 = 20000
```

You can keep at most **20K** verbatim — the summary ate the rest. Raise `reserve` to 110000 and it gets worse:

```text
trigger       = 90000
summaryBudget = min(88000, 192000) = 88000
keepRecent    <  90000 − 88000 = 2000   ← almost nothing kept verbatim
```

### The hard ceiling on `reserve`

With a big-output model, `reserve` has a hard ceiling — past it, the summary alone exceeds the trigger and **no `keepRecent` works** (not even 0):

```text
1.8 × reserve  <  cap          (big-output regime, keepRecent = 0)
reserve        <  cap ÷ 1.8
```

For `cap = 200000`: `reserve < 111111`. At `reserve = 112000`, `summaryBudget = 89600` but `trigger = 88000` — the summary alone re-triggers compaction in an infinite loop.

### What to do when the summary is too big

If you're hitting the ceiling (summary approaches the trigger), you have three options — pick based on what you can spare:

| Option | Effect | Tradeoff |
| --- | --- | --- |
| Lower `reserve` | Smaller summary, bigger trigger, more `keepRecent` room | Less detail preserved in the summary |
| Raise `cap` (up to native window) | More total room for everything | Compaction fires later; longer context before summarising |
| Accept tiny `keepRecent` | Keeps the big summary | Almost nothing verbatim; the model relies on the summary alone |

You cannot have all three of big summaries, big `keepRecent`, and a low `cap`. The extension can't relax this — it's arithmetic.

### Choosing values

| Goal | Tune | Effect |
| --- | --- | --- |
| Fire sooner (compact more often) | Lower `cap` or raise `reserve` | Less working context between compactions |
| Keep more recent context | Raise `keepRecent` (lower `reserve` on big-output models) | More verbatim turns preserved |
| Bigger summaries | Raise `reserve` (only helps if `maxOutput > 0.8 × reserve`) | Up to `0.8 × reserve`; squeezes `keepRecent` |
| Later compaction (more working room) | Raise `cap` | More context before summarising |

**Sanity check before shipping** — verify the no-loop constraint holds:

```text
summaryBudget = min(0.8 × reserve, maxOutput)
keepRecent    < cap − reserve − summaryBudget   (must be > 0, ideally with headroom)
```

### Cap clamped to native window

If a configured cap exceeds a model's native context window, the effective cap is **silently clamped down** to that native window (the model cannot use room it does not have). The extension warns you when this happens so you know the effective cap is the native window, not your configured value:

```
compaction-control: provider/model configured cap 256,000 > native 200,000 — effective cap clamped down to 200,000
```

This is informational — the clamp is the correct behavior (the model was already running at native). The warning just makes the effective cap visible so you can lower the configured cap to match, or accept that the model runs at native. The warning fires once per model per session (no spam on `/reload`).

---

## 🔧 What it does (mechanism)

| Event | Action |
| --- | --- |
| `session_start` | Read config, cap all matching models in the registry |
| `resources_discover` | Re-cap (covers `/reload` and late model loads) |
| `model_select` | Cap the newly selected model + re-sweep the registry |
| `session_before_compact` | If a specific `compactionModel.model` is set, run pi's native `compact()` with it; otherwise notify and defer to pi's default |

The cap works by mutating `model.contextWindow` in Pi's in-memory model registry — the same mechanism [pi-context-cap](https://github.com/AlexWootton/pi-context-cap) uses. Everything else in Pi's compaction machinery (summariser model unless overridden, prompt, recovery flow, `/compact`, `session_before_compact` hooks) is unchanged.

---

## ✅ Verify it works

Run Pi in non-interactive print mode — if the extension loads cleanly, it exits 0:

```bash
pi --no-tools --print "reply with exactly: OK"
# → OK
```

On startup (with `notify: true`) you'll see notifications like:

```
compaction-control: active openai/gpt-6-astra 1,050,000 -> 256,000
compaction-control: capped 1 model(s)
compaction-control: OK on pi 0.85.0 — cap 200,000, summariser current@high (all capability probes passed)
```

The status line shows your **effective cap** and **compaction summariser** alongside the capability check. Run `/compaction-control-doctor` any time for a full breakdown (pi version, effective config, each probe ✓/✗).

Check the effective window at any time:

```bash
pi --list-models | grep -i context
```

---

## 🌐 Project-local overrides

Drop a `<project>/.pi/settings.json` with only the keys you want to override:

```json
{
  "contextCap": { "cap": 180000 }
}
```

Project config merges per top-level key over global — so you can tighten the cap for a specific repo without touching the global file.

---

## 📋 Requirements

- Pi Coding Agent `>= 0.85.0` (uses the `compact()` export and `modelRegistry.getApiKeyAndHeaders()`)

---

## License

MIT
