# pi-compaction-control

[![npm version](https://img.shields.io/npm/v/pi-compaction-control?logo=npm)](https://www.npmjs.com/package/pi-compaction-control)
[![npm license](https://img.shields.io/npm/l/pi-compaction-control)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/pi-compaction-control)](https://www.npmjs.com/package/pi-compaction-control)
[![GitHub Actions](https://github.com/aalexren/pi-compaction-control/actions/workflows/publish.yml/badge.svg)](https://github.com/aalexren/pi-compaction-control/actions/workflows/publish.yml)
[![GitHub release](https://img.shields.io/github/v/release/aalexren/pi-compaction-control?logo=github)](https://github.com/aalexren/pi-compaction-control/releases)

A single [Pi Coding Agent](https://github.com/earendil-works/pi) extension that gives you full control over conversation compaction: a **granular per-model hard cap** on context windows, and a **configurable compaction model** — both read from Pi's own `settings.json`, so everything lives in one place.

No external config files, no separate package install. Drop the file in `~/.pi/agent/extensions/` and configure in `settings.json`.

---

## 🤔 Why

Pi's built-in compaction settings (`compaction.reserveTokens`, `compaction.keepRecentTokens`) control *how much* to keep and *how much room to leave* — but they can't cap the model's context window itself. On long-context models (1M-token Claude, 500K Grok, etc.) compaction only fires at `contextWindow - reserveTokens`, which is rarely what you want for day-to-day work.

This extension adds the missing piece — a client-side cap on `model.contextWindow` — and lets you pick which model runs the compaction summariser, all configurable per-model.

| Capability | Without extension | With extension | How |
| --- | --- | --- | --- |
| `reserveTokens` | ✅ | ✅ | `compaction.reserveTokens` |
| `keepRecentTokens` | ✅ | ✅ | `compaction.keepRecentTokens` |
| Hard cap on context window | ❌ | ✅ | `contextCap` |
| Compaction summariser model | ❌ | ✅ | `compactionModel` |

> **Note:** `reserveTokens` and `keepRecentTokens` cannot be overridden by an extension — Pi's `prepareCompaction()` runs *before* the `session_before_compact` event and bakes them into the preparation. They must stay in `settings.json`.

---

## 📦 Built-in context settings (out of the box)

Pi already ships context/compaction controls in `settings.json` — you may not need this extension at all if these are enough. They work with zero install:

```jsonc
{
  "compaction": {
    "enabled": true,            // default: true — enable auto-compaction
    "reserveTokens": 16384,    // default: 16384 — tokens reserved for the LLM response
    "keepRecentTokens": 20000  // default: 20000 — recent tokens kept (not summarized)
  },
  "branchSummary": {
    "reserveTokens": 16384,    // default: 16384 — tokens reserved when selecting branch history
    "skipPrompt": false        // default: false — skip "Summarize branch?" prompt on /tree
  }
}
```

| Built-in key | Default | What it does |
| --- | --- | --- |
| `compaction.enabled` | `true` | Enable auto-compaction (disable with `false`; `/compact` still works manually) |
| `compaction.reserveTokens` | `16384` | Tokens to reserve for the LLM response — auto-compaction fires when `contextTokens > contextWindow - reserveTokens` |
| `compaction.keepRecentTokens` | `20000` | Recent tokens to keep verbatim (not summarized) |
| `branchSummary.reserveTokens` | `16384` | Tokens reserved when selecting branch history (output capped at 4096) |
| `branchSummary.skipPrompt` | `false` | Skip the "Summarize branch?" prompt on `/tree` navigation |

Auto-compaction trigger (Pi core):

```text
contextTokens > contextWindow - reserveTokens
```

**What the built-in keys *cannot* do** (and why this extension exists):

- ❌ Cap the model's `contextWindow` itself — Pi uses the model's native window (e.g. 1,000,000 for long-context Claude), so compaction only fires near that native limit.
- ❌ Choose a different model for the compaction summariser — Pi always uses the active conversation model.

This extension adds exactly those two missing pieces. The built-in `compaction.*` keys continue to work alongside it (and are required — the extension can't override `reserveTokens`/`keepRecentTokens`).

---

## ⬇️ Install

### Option A — global (recommended)

Copy the package directory into Pi's global extensions directory:

```bash
cp -r pi-compaction-control ~/.pi/agent/extensions/
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. No `pi install` needed.

### Option B — from npm (recommended)

```bash
pi install npm:pi-compaction-control
```

### Option C — from this repo as a pi package

```bash
pi install git:github.com/aalexren/pi-compaction-control
```

### Option D — project-local

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
    "keepRecentTokens": 131072
  }
}
```

### 2. `contextCap` — granular per-model hard cap

Caps every matching model's effective `contextWindow` so auto-compaction fires at `cap - reserveTokens` instead of the model's native window.

```jsonc
{
  "contextCap": {
    "cap": 262144,                       // default target contextWindow (tokens)
    "appliesOver": 262144,               // only cap models whose native window exceeds this
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
| `cap` | `262144` | Target `contextWindow` for pattern-matched models |
| `appliesOver` | `262144` | Only cap models whose native window exceeds this (ignored for per-model overrides) |
| `matchPatterns` | `["*"]` | id-substring matchers; `"*"` matches all |
| `models` | `{}` | Per-model-id granular caps. Always wins over pattern matching |
| `notify` | `true` | Show a notification when a model is capped |

**How matching works** (per model):

1. If `models[model.id]` is set → cap to that value (always, ignores `appliesOver`).
2. Else if `model.id` matches any `matchPatterns` → cap to `cap` only if `model.contextWindow > appliesOver`.
3. Else → leave unchanged.

Idempotent: models already at or below their target are skipped.

**Examples**

Cap everything at 262k:

```json
{ "contextCap": { "cap": 262144 } }
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
    "thinkingLevel": "medium"            // optional: minimal|low|medium|high|xhigh|max
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

## 🧮 How compaction now behaves

With the defaults (`contextCap.cap = 262144`, `compaction.reserveTokens = 32768`):

```
auto-compaction fires at  262144 − 32768 = 229376 tokens
```

using the current conversation model (since `compactionModel.model = "current"`).

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
compaction-control: openai/gpt-6-astra 1,050,000 -> 262,144
compaction-control: capped 1 model(s)
```

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

## License

MIT
