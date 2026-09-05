/**
 * compaction-control — single extension covering all compaction necessities.
 *
 * Reads its config from pi's own settings.json (the pi convention — same place
 * `compactionModel`-style packages put it), so you configure everything in one
 * file: ~/.pi/agent/settings.json (global) or <project>/.pi/settings.json
 * (project overrides global, per-key).
 *
 * ────────────────────────────── contextCap ──────────────────────────────
 * Granular, per-model hard cap on every model's effective contextWindow, so
 * pi's auto-compaction fires at `cap - reserveTokens` instead of the model's
 * native (often huge) window. This is the one thing settings.json's built-in
 * compaction.* fields cannot do.
 *
 *   "contextCap": {
 *     "cap": 256000,                       // optional: target contextWindow for pattern-matched models (no default)
 *     "matchPatterns": ["*"],              // optional: id-substring matchers; ["*"] = all (no default)
 *     "models": {                          // optional: per-model-id granular overrides (wins over patterns)
 *       "gpt-6-astra": 200000,
 *       "grok-4-6": 180000
 *     },
 *     "notify": true                       // notify on each cap applied (default: true)
 *   }
 *
 * All fields optional. No implicit defaults: if cap/matchPatterns/models
 * are unset, the extension does nothing.
 *
 * ───────────────────────────── compactionModel ──────────────────────────
 * Choose which model runs pi's native compaction summariser. Follows pi's
 * style (`compactionModel: { model, thinkingLevel }`).
 *
 *   "compactionModel": {
 *     "model": "openai/gpt-6-astra",  // "provider/modelId", or "current"/"default"/null
 *     "thinkingLevel": "medium"              // optional: minimal|low|medium|high|xhigh|max
 *   }
 *
 * - "current" / "default" / unset → pi's default: compact with the active
 *   conversation model. The extension does nothing in session_before_compact.
 * - a specific "provider/modelId" → the extension resolves it, calls pi's own
 *   exported compact() with that model, and returns the result. Pi's native
 *   prompts, cut-point logic, file-operation tracking, and iterative summary
 *   updates are all preserved (we reuse pi's compact(), not a custom prompt).
 *   If the configured model can't be resolved or compaction fails, control
 *   falls back to pi (active model).
 *
 * ─────────────── built-in (still in settings.json, not here) ────────────
 *   compaction.reserveTokens    = 32768
 *   compaction.keepRecentTokens = 131072
 *   (Cannot be overridden by an extension: prepareCompaction() runs before
 *    session_before_compact and bakes them into `preparation`.)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Model } from "@earendil-works/pi-coding-agent";
import { compact, VERSION } from "@earendil-works/pi-coding-agent";
import type {
	CompactionPreparation,
	CompactionResult,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

// ─────────────────────────── defaults (fallback) ───────────────────────────
// No implicit cap: if cap/matchPatterns/models are unset in settings, the
// extension does nothing. Only `notify` defaults to true (cosmetic).
const DEFAULT_CONTEXT_CAP = {
	cap: undefined as number | undefined,
	matchPatterns: [] as string[],
	models: {} as Record<string, number>,
	notify: true,
};
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const CONFIG_DIR_NAME = ".pi";

// ─────────────────────────────── types ─────────────────────────────────────
interface ContextCapConfig {
	cap?: number;
	matchPatterns?: string[];
	models?: Record<string, number>;
	notify?: boolean;
}
interface CompactionModelConfig {
	/** "provider/modelId", or "current"/"default"/null/undefined for the active model. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
}
interface CompactionCoreSettings {
	reserveTokens?: number;
	keepRecentTokens?: number;
	enabled?: boolean;
}
interface ResolvedConfig {
	contextCap?: ContextCapConfig;
	compactionModel?: CompactionModelConfig;
	compaction?: CompactionCoreSettings;
}

// ─────────────────────────── config reading ────────────────────────────────
/** Safely read+parse a JSON settings file. Returns {} on any error. */
function readJson(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Merge global ~/.pi/agent/settings.json with project <cwd>/.pi/settings.json.
 * Project wins per top-level key (shallow merge).
 */
function readConfig(cwd: string): ResolvedConfig {
	const globalCfg = readJson(GLOBAL_SETTINGS_PATH);
	const projectCfg = readJson(join(cwd, CONFIG_DIR_NAME, "settings.json"));
	const merged: Record<string, unknown> = { ...globalCfg, ...projectCfg };
	const out: ResolvedConfig = {};
	if (merged.contextCap && typeof merged.contextCap === "object") {
		out.contextCap = merged.contextCap as ContextCapConfig;
	}
	if (merged.compactionModel && typeof merged.compactionModel === "object") {
		out.compactionModel = merged.compactionModel as CompactionModelConfig;
	}
	if (merged.compaction && typeof merged.compaction === "object") {
		out.compaction = merged.compaction as CompactionCoreSettings;
	}
	return out;
}

// ─────────────────────────── context cap logic ─────────────────────────────
const idMatchesPatterns = (modelId: string, patterns: string[]): boolean => {
	if (patterns.includes("*")) return true;
	const id = modelId.toLowerCase();
	return patterns.some((p) => p !== "*" && id.includes(p.toLowerCase()));
};

/** Resolve the target cap for a model given granular config. Returns undefined if not applicable. */
function targetCapFor(
	model: Model<any>,
	cfg: ContextCapConfig,
): number | undefined {
	const cap = cfg.cap ?? DEFAULT_CONTEXT_CAP.cap;
	const models = cfg.models ?? DEFAULT_CONTEXT_CAP.models;
	const patterns = cfg.matchPatterns ?? DEFAULT_CONTEXT_CAP.matchPatterns;

	// Per-model granular override always wins.
	if (models[model.id] !== undefined) return models[model.id];

	// Pattern-based: only cap if a cap is explicitly set AND the model matches.
	if (cap !== undefined && idMatchesPatterns(model.id, patterns)) {
		return cap;
	}
	return undefined;
}

/** Cap a single model in place. Returns the new window if changed, else undefined. */
function capModel(
	model: Model<any>,
	cfg: ContextCapConfig,
): number | undefined {
	const target = targetCapFor(model, cfg);
	if (target === undefined) return undefined;
	if (model.contextWindow <= target) return undefined; // idempotent + respect smaller native windows
	model.contextWindow = target;
	return target;
}

/** Apply caps across the registry. Returns [countCapped, details[]]. */
function applyCaps(
	modelRegistry: { getAvailable?: () => Model<any>[] },
	cfg: ContextCapConfig,
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
): [number, string[]] {
	const models = modelRegistry.getAvailable?.() ?? [];
	let capped = 0;
	const details: string[] = [];
	const shouldNotify = cfg.notify ?? DEFAULT_CONTEXT_CAP.notify;
	for (const model of models) {
		const before = model.contextWindow;
		const target = capModel(model, cfg);
		if (target !== undefined) {
			capped++;
			const line = `${model.provider}/${model.id} ${before.toLocaleString()} -> ${target.toLocaleString()}`;
			details.push(line);
			if (shouldNotify && notify) notify(`compaction-control: ${line}`, "info");
		}
	}
	return [capped, details];
}

// ─────────────────────── compaction model logic ────────────────────────────
const CURRENT_MODEL_TOKENS = new Set(["current", "default", "active", ""]);

/** Resolve "provider/modelId" to a Model via the registry. */
function resolveModel(
	modelRegistry: { find: (p: string, m: string) => Model<any> | undefined },
	spec: string,
): Model<any> | undefined {
	const slash = spec.indexOf("/");
	if (slash < 0) return undefined;
	const provider = spec.slice(0, slash);
	const modelId = spec.slice(slash + 1);
	return modelRegistry.find(provider, modelId);
}

// ─────────────────────── startup config validation ──────────────────────────
// Pi's compact() caps the summary at maxTokens = min(0.8 * reserveTokens, model.maxTokens).
// If that budget is too small for the configured thinking level, compaction will fail
// at runtime. Validate proactively and warn with concrete suggestions.
const MIN_SUMMARY_TOKENS = 1500; // floor for a useful summary after thinking
const HIGH_THINKING_LEVELS = new Set(["high", "xhigh", "max"]);

/**
 * Validate the compaction-model config against the summary budget and warn early.
 * Returns void; emits ui.notify warnings. Best-effort — never throws.
 */
function validateCompactionConfig(ctx: {
	modelRegistry: any;
	model?: Model<any>;
	ui: any;
	hasUI: boolean;
	cwd: string;
}) {
	if (!ctx.hasUI) return;
	const cfg = effectiveCompactionModelCfg(ctx.cwd);
	const spec = cfg?.model?.trim() ?? "";
	const thinkingLevel = cfg?.thinkingLevel;
	const isCurrent = CURRENT_MODEL_TOKENS.has(spec.toLowerCase());

	// Resolve the compaction model: explicit, or the active model for "current".
	const model = isCurrent ? ctx.model : resolveModel(ctx.modelRegistry, spec);
	if (!model) return; // can't validate without a model; resolve errors handled elsewhere

	const reserveTokens = readConfig(ctx.cwd).compaction?.reserveTokens ?? 16384;
	const summaryBudget = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const notify = (msg: string) =>
		ctx.ui.notify(`compaction-control: ${msg}`, "warning");

	// (0) Cap exceeds native — the compaction model's configured cap is above
	// its native context window, so the cap is clamped down (no effect).
	const capCfg = readConfig(ctx.cwd).contextCap ?? DEFAULT_CONTEXT_CAP;
	const capTarget = targetCapFor(model, capCfg);
	if (
		capTarget !== undefined &&
		capTarget > model.contextWindow &&
		!warnedCapExceedsNative.has(`${model.provider}/${model.id}`)
	) {
		warnedCapExceedsNative.add(`${model.provider}/${model.id}`);
		notify(
			`${model.provider}/${model.id} compaction-model configured cap ${capTarget.toLocaleString()} > native ${model.contextWindow.toLocaleString()} — effective cap clamped down to ${model.contextWindow.toLocaleString()}`,
		);
	}

	// (1) Budget too small for any summary — suggest raising reserveTokens.
	if (summaryBudget < MIN_SUMMARY_TOKENS) {
		const minReserve = Math.ceil(MIN_SUMMARY_TOKENS / 0.8);
		if (model.maxTokens > 0 && model.maxTokens < MIN_SUMMARY_TOKENS) {
			notify(
				`${model.provider}/${model.id} maxOutput=${model.maxTokens} is too small for a summary. Use a model with larger output (e.g. grok-4.5: 500000).`,
			);
		} else {
			notify(
				`summary budget ${summaryBudget} = min(0.8×reserve=${reserveTokens}, maxOut=${model.maxTokens}) is below ${MIN_SUMMARY_TOKENS}. Set compaction.reserveTokens >= ${minReserve}.`,
			);
		}
		return;
	}

	// (2) Reasoning model + high thinking + tight budget → likely truncation.
	if (
		model.reasoning &&
		thinkingLevel &&
		HIGH_THINKING_LEVELS.has(thinkingLevel) &&
		summaryBudget < 6000
	) {
		const bigger = (
			ctx.modelRegistry.getAvailable?.() as Model<any>[] | undefined
		)
			?.filter((m) => m.maxTokens > model.maxTokens)
			?.sort((a, b) => b.maxTokens - a.maxTokens)?.[0];
		const suggest = bigger
			? `or switch to ${bigger.provider}/${bigger.id} (maxOutput=${bigger.maxTokens.toLocaleString()})`
			: "or switch to a model with larger output";
		notify(
			`${model.provider}/${model.id} maxOutput=${model.maxTokens.toLocaleString()}, summary budget ${summaryBudget.toLocaleString()} with ${thinkingLevel} thinking may truncate. Set compactionModel.thinkingLevel="minimal" ${suggest}.`,
		);
	}
}

// ─────────────────────── runtime override (session-scoped) ────────────────
// Set by the /compaction-model command; wins over settings.json until reset
// or until the session ends. `null` = use settings.json default.
let runtimeOverride: CompactionModelConfig | null = null;

// Track models warned about cap-exceeds-native to avoid spam on re-runs.
const warnedCapExceedsNative = new Set<string>();

/** Effective compaction-model config: runtime override → settings.json default. */
function effectiveCompactionModelCfg(
	cwd: string,
): CompactionModelConfig | undefined {
	return runtimeOverride ?? readConfig(cwd).compactionModel;
}

/** Run pi's native compact() with a resolved model + auth. Returns CompactionResult or throws. */
async function runCompact(
	preparation: CompactionPreparation,
	resolved: Model<any>,
	auth: {
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	},
	customInstructions: string | undefined,
	signal: AbortSignal,
	thinkingLevel: ThinkingLevel | undefined,
): Promise<CompactionResult> {
	// Defensive wrapper: pi's compact() has 12 positional params and no stable
	// contract. If the signature changes on a pi update, throw a clear error the
	// caller catches and reports — never an uncaught crash that breaks pi.
	if (typeof compact !== "function") {
		throw new Error("pi compact() export is missing or not a function");
	}
	return compact(
		preparation,
		resolved,
		auth.apiKey,
		auth.headers,
		customInstructions,
		signal,
		thinkingLevel,
		undefined,
		auth.env,
	);
}

// ─────────────────── capability probes (serviceability) ───────────────────
// Probe the actual pi behaviors this extension relies on. These are
// implementation details, not a stable API contract — a pi update could
// change them. Detect breakage at startup and warn loudly + degrade safely.
interface CapabilityReport {
	piVersion: string;
	activeModelMutable: boolean; // mutating ctx.model.contextWindow persists (cap-trigger fix)
	registryModelsMutable: boolean; // mutating registry model objects persists (sweep)
	compactExported: boolean; // compact() is importable and callable
	authShapeOk: boolean; // getApiKeyAndHeaders() returns {ok, apiKey, headers, env}
	preparationShapeOk: boolean; // event.preparation has firstKeptEntryId/tokensBefore
}

/** Probe pi capabilities against the live session context. Best-effort, never throws. */
async function probeCapabilities(ctx: {
	model?: Model<any>;
	modelRegistry: any;
	ui: any;
	hasUI: boolean;
}): Promise<CapabilityReport> {
	const report: CapabilityReport = {
		piVersion: VERSION ?? "unknown",
		activeModelMutable: false,
		registryModelsMutable: false,
		compactExported: typeof compact === "function",
		authShapeOk: false,
		preparationShapeOk: false,
	};

	// Probe 1: does mutating ctx.model.contextWindow persist?
	try {
		const m = ctx.model;
		if (m && typeof m.contextWindow === "number") {
			const orig = m.contextWindow;
			m.contextWindow = orig + 1;
			report.activeModelMutable = m.contextWindow === orig + 1;
			m.contextWindow = orig; // restore
		}
	} catch {
		/* read-only or frozen */
	}

	// Probe 2: are registry model objects mutable?
	try {
		const models = ctx.modelRegistry.getAvailable?.() ?? [];
		const m = models[0];
		if (m && typeof m.contextWindow === "number") {
			const orig = m.contextWindow;
			m.contextWindow = orig + 1;
			report.registryModelsMutable = m.contextWindow === orig + 1;
			m.contextWindow = orig;
		}
	} catch {
		/* frozen */
	}

	// Probe 3: getApiKeyAndHeaders() return shape.
	try {
		const m = ctx.model ?? ctx.modelRegistry.getAvailable?.()?.[0];
		if (m) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
			report.authShapeOk =
				typeof auth === "object" &&
				auth !== null &&
				"ok" in auth &&
				(auth.ok ? typeof auth : true) &&
				(!auth.ok || ("apiKey" in auth && "headers" in auth && "env" in auth));
		}
	} catch {
		/* shape changed */
	}

	// Probe 4: preparation shape — can't fully probe without a compaction event,
	// but we can check the type exists via a lightweight structural hint. Mark
	// ok if the CompactionPreparation type is exported (heuristic: compact is).
	report.preparationShapeOk = report.compactExported; // conservative heuristic

	return report;
}

/** Brief description of the effective cap + compaction model, for status messages. */
function effectiveConfigBrief(ctx: {
	model?: Model<any>;
	cwd: string;
}): string {
	const parts: string[] = [];
	// Effective cap on the active model (after applyCaps ran).
	const m = ctx.model;
	if (m && typeof m.contextWindow === "number") {
		parts.push(`cap ${m.contextWindow.toLocaleString()}`);
	}
	// Effective compaction summariser model + thinking level.
	const cm = effectiveCompactionModelCfg(ctx.cwd);
	if (cm) {
		const spec = cm.model && cm.model.trim() ? cm.model : "current";
		const lvl = cm.thinkingLevel ? `@${cm.thinkingLevel}` : "";
		parts.push(`summariser ${spec}${lvl}`);
	}
	return parts.join(", ");
}

/** Warn the user about any broken capabilities. Returns true if all critical probes passed. */
function reportCapabilities(
	report: CapabilityReport,
	ui: any,
	hasUI: boolean,
	brief = "",
): boolean {
	if (!hasUI) return report.activeModelMutable && report.compactExported;
	const failures: string[] = [];
	if (!report.compactExported)
		failures.push("compact() export missing — compaction-model path disabled");
	if (!report.activeModelMutable)
		failures.push(
			"ctx.model.contextWindow is read-only — contextCap will NOT trigger compaction earlier (cap fix broken)",
		);
	if (!report.registryModelsMutable)
		failures.push(
			"registry models are frozen — contextCap sweep is display-only",
		);
	if (!report.authShapeOk)
		failures.push(
			"getApiKeyAndHeaders() shape changed — compaction-model auth may fail",
		);
	const suffix = brief ? ` — ${brief}` : "";
	if (failures.length === 0) {
		ui.notify(
			`compaction-control: OK on pi ${report.piVersion}${suffix} (all capability probes passed)`,
			"info",
		);
		return true;
	}
	ui.notify(
		`compaction-control: ⚠ pi ${report.piVersion}${suffix} — ${failures.length} capability issue(s): ${failures.join("; ")}. Run /compaction-control-doctor for details.`,
		"warning",
	);
	return false;
}

// ─────────────────────────────── extension ─────────────────────────────────
export default function (pi: ExtensionAPI) {
	// Cap on session start + resource discovery (covers initial load + /reload).
	// IMPORTANT: must cap ctx.model (the active model = agent's this.model) directly,
	// not just sweep modelRegistry.getAvailable() — the agent's shouldCompact() reads
	// this.model.contextWindow, which is a DIFFERENT object from the registry display
	// models. Sweeping the registry alone does not trigger compaction earlier.
	const applyOnStart = (ctx: {
		modelRegistry: any;
		model?: Model<any>;
		ui: any;
		hasUI: boolean;
		cwd: string;
	}) => {
		const cfg = readConfig(ctx.cwd).contextCap ?? DEFAULT_CONTEXT_CAP;
		// Cap the active model first (this is what shouldCompact() reads).
		if (ctx.model) {
			const before = ctx.model.contextWindow;
			const target = capModel(ctx.model, cfg);
			if (
				target !== undefined &&
				(cfg.notify ?? DEFAULT_CONTEXT_CAP.notify) &&
				ctx.hasUI
			) {
				ctx.ui.notify(
					`compaction-control: active ${ctx.model.provider}/${ctx.model.id} ${before.toLocaleString()} -> ${target.toLocaleString()}`,
					"info",
				);
			}
		}
		// Also sweep the registry so /context, --list-models-in-session, and any
		// registry reads see the capped windows.
		const [n] = applyCaps(
			ctx.modelRegistry,
			cfg,
			ctx.hasUI ? ctx.ui.notify : undefined,
		);
		if (n > 0 && ctx.hasUI) {
			ctx.ui.notify(`compaction-control: capped ${n} model(s)`, "info");
		}
		// Validate compaction-model config against the summary budget.
		validateCompactionConfig(ctx);
		// Probe pi capabilities (serviceability) — detect breakage from pi updates.
		probeCapabilities(ctx)
			.then((report) => {
				reportCapabilities(report, ctx.ui, ctx.hasUI, effectiveConfigBrief(ctx));
			})
			.catch(() => {
				/* best-effort, never throw on startup */
			});
	};

	pi.on("session_start", (_event, ctx) => applyOnStart(ctx));
	pi.on("resources_discover", (_event, ctx) => applyOnStart(ctx));

	// Re-cap when the active model changes (new model may have a fresh native window).
	pi.on("model_select", (event, ctx) => {
		const cfg = readConfig(ctx.cwd).contextCap ?? DEFAULT_CONTEXT_CAP;
		const model = event.model;
		const before = model.contextWindow;
		const target = capModel(model, cfg);
		if (
			target !== undefined &&
			(cfg.notify ?? DEFAULT_CONTEXT_CAP.notify) &&
			ctx.hasUI
		) {
			ctx.ui.notify(
				`compaction-control: ${model.provider}/${model.id} ${before.toLocaleString()} -> ${target.toLocaleString()}`,
				"info",
			);
		}
		// Re-sweep in case switching providers surfaced new models.
		applyCaps(ctx.modelRegistry, cfg, ctx.hasUI ? ctx.ui.notify : undefined);
		// Re-validate: a model switch can change maxTokens/thinking and break compaction.
		validateCompactionConfig(ctx);
	});

	// Compaction model: effective config = runtime override → settings.json.
	// - "current"/unset + no thinkingLevel → defer to pi default (active model).
	// - "current" + thinkingLevel → resolve active model, run compact() with that level.
	// - "provider/modelId" → resolve + run compact() with optional thinkingLevel.
	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = effectiveCompactionModelCfg(ctx.cwd);
		const spec = cfg?.model?.trim() ?? "";
		const thinkingLevel = cfg?.thinkingLevel;
		const isCurrent = CURRENT_MODEL_TOKENS.has(spec.toLowerCase());

		// Pure default: "current" with no thinking-level override → let pi handle it.
		if (isCurrent && thinkingLevel === undefined) {
			const m = ctx.model;
			if (ctx.hasUI && m) {
				ctx.ui.notify(
					`compaction-control: compacting with current model ${m.provider}/${m.id} (window ${m.contextWindow.toLocaleString()})`,
					"info",
				);
			}
			return; // no compaction result → pi proceeds with active model
		}

		// Resolve the model: explicit "provider/modelId", or the active model for "current".
		const resolved = isCurrent
			? ctx.model
			: resolveModel(ctx.modelRegistry, spec);
		if (!resolved) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`compaction-control: model "${spec}" not found — falling back to active model`,
					"warning",
				);
			}
			return; // fallback to pi default
		}

		// Auth for the resolved model.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved);
		if (!auth.ok) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`compaction-control: auth failed for ${resolved.provider}/${resolved.id} — falling back`,
					"warning",
				);
			}
			return;
		}

		const { preparation, customInstructions, signal } = event;
		if (ctx.hasUI) {
			const lvl = thinkingLevel ? ` @ ${thinkingLevel}` : "";
			ctx.ui.notify(
				`compaction-control: compacting with ${resolved.provider}/${resolved.id}${lvl} (window ${resolved.contextWindow.toLocaleString()})`,
				"info",
			);
		}

		const tryCompact = async (level: ThinkingLevel | undefined) =>
			runCompact(
				preparation as CompactionPreparation,
				resolved,
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
				customInstructions,
				signal,
				level,
			);

		try {
			// Try with the configured thinking level first.
			const result = await tryCompact(thinkingLevel);
			return { compaction: result };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const hitTokenLimit = /token limit|incomplete|hit the token/i.test(msg);
			// Bypass: if the configured thinking level blew the output budget,
			// retry with minimal thinking so compaction still succeeds.
			if (hitTokenLimit && thinkingLevel && thinkingLevel !== "minimal") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`compaction-control: ${thinkingLevel} thinking hit output limit — retrying with minimal`,
						"warning",
					);
				}
				try {
					const result = await tryCompact("minimal");
					return { compaction: result };
				} catch (err2) {
					const msg2 = err2 instanceof Error ? err2.message : String(err2);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`compaction-control: minimal-thinking retry also failed (${msg2}) — falling back`,
							"warning",
						);
					}
					return; // fallback to pi default
				}
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					`compaction-control: compact() failed (${msg}) — falling back`,
					"warning",
				);
			}
			return; // fallback to pi default
		}
	});

	// ───────────── /compaction-model command (runtime override) ─────────────
	// Usage:
	//   /compaction-model                  → pick model + thinking level interactively
	//   /compaction-model <provider/model> → set model directly (keeps current level)
	//   /compaction-model current          → use the active conversation model
	//   /compaction-model reset            → clear override, revert to settings.json default
	//   /compaction-model status           → show effective config
	pi.registerCommand("compaction-model", {
		description:
			"Set the compaction summariser model for this session (overrides settings.json)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			// status
			if (arg === "status") {
				const eff = effectiveCompactionModelCfg(ctx.cwd);
				const src = runtimeOverride ? "runtime override" : "settings.json default";
				ctx.ui.notify(
					`compaction-control: ${src} → model=${eff?.model ?? "current"}, thinkingLevel=${eff?.thinkingLevel ?? "(unset)"}`,
					"info",
				);
				return;
			}

			// reset
			if (arg === "reset" || arg === "default") {
				runtimeOverride = null;
				ctx.ui.notify(
					"compaction-control: runtime override cleared — using settings.json default",
					"info",
				);
				return;
			}

			// direct set: /compaction-model <provider/model> | current
			if (arg) {
				const prev = effectiveCompactionModelCfg(ctx.cwd);
				runtimeOverride = { model: arg, thinkingLevel: prev?.thinkingLevel };
				ctx.ui.notify(
					`compaction-control: compaction model set to ${arg}${prev?.thinkingLevel ? ` @ ${prev.thinkingLevel}` : ""} (runtime override)`,
					"info",
				);
				validateCompactionConfig(ctx);
				return;
			}

			// interactive: pick model, then thinking level
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"compaction-control: interactive picker needs a TUI; use /compaction-model <provider/model>",
					"warning",
				);
				return;
			}
			const models = ctx.modelRegistry.getAvailable() as Model<any>[];
			const modelOptions = [
				"current (active model)",
				...models.map((m) => `${m.provider}/${m.id}`),
			];
			const picked = await ctx.ui.select("Compaction model:", modelOptions);
			if (!picked) return;
			const modelSpec = picked.startsWith("current") ? "current" : picked;

			const levelOptions = [
				"default (unset)",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			];
			const pickedLevel = await ctx.ui.select(
				"Thinking level for compaction:",
				levelOptions,
			);
			const thinkingLevel =
				!pickedLevel || pickedLevel.startsWith("default")
					? undefined
					: (pickedLevel as ThinkingLevel);

			runtimeOverride = { model: modelSpec, thinkingLevel };
			ctx.ui.notify(
				`compaction-control: compaction model set to ${modelSpec}${thinkingLevel ? ` @ ${thinkingLevel}` : ""} (runtime override)`,
				"info",
			);
			validateCompactionConfig(ctx);
		},
	});

	// ───────────── /compaction-control-doctor (serviceability) ─────────────
	// Runs capability probes on demand and reports pi-compatibility status.
	// Use after a pi update to verify the extension still works.
	pi.registerCommand("compaction-control-doctor", {
		description: "Check pi compatibility (capability probes + version)",
		handler: async (_args, ctx) => {
			// Re-run probes live so the report reflects the current pi runtime.
			let report: CapabilityReport | null = null;
			try {
				report = await probeCapabilities(ctx);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`compaction-control: doctor probe crashed (${msg})`, "error");
				return;
			}
			if (!report) return;
			const ok = reportCapabilities(
				report,
				ctx.ui,
				ctx.hasUI,
				effectiveConfigBrief(ctx),
			);
			// Detailed breakdown.
			const lines = [
				`pi version: ${report.piVersion}`,
				`effective config: ${effectiveConfigBrief(ctx) || "(none)"}`,
				`compact() exported: ${report.compactExported ? "✓" : "✗"}`,
				`ctx.model mutable (cap trigger): ${report.activeModelMutable ? "✓" : "✗"}`,
				`registry models mutable (sweep): ${report.registryModelsMutable ? "✓" : "✗"}`,
				`getApiKeyAndHeaders() shape: ${report.authShapeOk ? "✓" : "✗"}`,
				`preparation shape: ${report.preparationShapeOk ? "✓" : "? (heuristic)"}`,
				ok
					? "overall: ✓ all critical probes passed"
					: "overall: ⚠ see failures above",
			];
			ctx.ui.notify(
				`compaction-control doctor:\n${lines.join("\n")}`,
				ok ? "info" : "warning",
			);
		},
	});
}
