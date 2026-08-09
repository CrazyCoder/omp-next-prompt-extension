import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import {
	buildSuggestionContext,
	configuredModelSpec,
	contentText,
	normalizeModelSpec,
	normalizeSuggestion,
} from "./logic";

const WIDGET_KEY = "next-prompt-suggestion";
const ACCEPT_SHORTCUT = "alt+/";
const MODEL_FLAG = "suggestions-model";
const MODEL_ENVIRONMENT_VARIABLE = "OMP_SUGGESTIONS_MODEL";
const ACCEPT_INPUTS: Record<string, true> = {
	"\x1b/": true,
	"\x1bO/": true,
	"\x1b[47;3u": true,
};
const GENERATION_TIMEOUT_MS = 20_000;
const EDITOR_SETTLE_MS = 50;
const REARM_DELAY_MS = 2_000;
const SYSTEM_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into the coding assistant.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
The assistant offers options → suggest the one the user would likely pick, based on conversation
The assistant asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

export default function nextPromptExtension(pi: ExtensionAPI): void {
	pi.registerFlag(MODEL_FLAG, {
		description:
			"Model for next-prompt suggestions (smol, slow, current, @role, or provider/model)",
		type: "string",
	});

	let enabled = true;
	let defaultModelSpec = "@smol";
	let modelSpec = defaultModelSpec;
	let suggestion: string | undefined;
	let lastSuggestion: string | undefined;
	let generation = 0;
	let generationAbort: AbortController | undefined;
	let editorCheckTimer: ReturnType<typeof setTimeout> | undefined;
	let rearmTimer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;
	let lastOutcome = "not generated yet";

	pi.setLabel("Next-prompt suggestions");

	function clearSuggestion(
		ctx: ExtensionContext,
		options: {
			abortGeneration?: boolean;
			forgetLast?: boolean;
			outcome?: string;
		} = {},
	): void {
		const {
			abortGeneration = true,
			forgetLast = true,
			outcome,
		} = options;
		generation += 1;
		suggestion = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (editorCheckTimer) clearTimeout(editorCheckTimer);
		if (rearmTimer) clearTimeout(rearmTimer);
		editorCheckTimer = undefined;
		rearmTimer = undefined;
		if (forgetLast) lastSuggestion = undefined;
		if (abortGeneration) {
			generationAbort?.abort();
			generationAbort = undefined;
		}
		if (outcome) lastOutcome = outcome;
	}

	function showSuggestion(ctx: ExtensionContext, value: string): void {
		suggestion = value;
		lastSuggestion = value;
		lastOutcome = `shown: ${value}`;
		ctx.ui.setWidget(
			WIDGET_KEY,
			[
				ctx.ui.theme.fg("dim", `Suggestion: ${value}`) +
					ctx.ui.theme.fg("muted", "  Alt+/ to accept"),
			],
			{ placement: "belowEditor" },
		);
	}

	function isKnownNonEditingInput(data: string): boolean {
		return (
			data === "\x1b[I" ||
			data === "\x1b[O" ||
			data === "\x1b[200~" ||
			data === "\x1b[201~" ||
			/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)
		);
	}

	function scheduleEditorCheck(
		ctx: ExtensionContext,
		editorTextBefore: string,
	): void {
		if (editorCheckTimer) clearTimeout(editorCheckTimer);
		editorCheckTimer = setTimeout(() => {
			editorCheckTimer = undefined;
			const editorTextAfter = ctx.ui.getEditorText();
			if (editorTextBefore.length === 0) {
				if (editorTextAfter.length === 0) return;
				const outcome = generationAbort
					? "aborted: editor changed"
					: "dismissed: editor changed";
				clearSuggestion(ctx, { forgetLast: false, outcome });
				return;
			}
			if (
				editorTextAfter.length > 0 ||
				!lastSuggestion ||
				!enabled ||
				!ctx.isIdle() ||
				ctx.hasPendingMessages()
			)
				return;
			const cached = lastSuggestion;
			if (rearmTimer) clearTimeout(rearmTimer);
			rearmTimer = setTimeout(() => {
				rearmTimer = undefined;
				if (
					lastSuggestion !== cached ||
					ctx.ui.getEditorText().length > 0 ||
					!enabled ||
					!ctx.isIdle() ||
					ctx.hasPendingMessages()
				)
					return;
				showSuggestion(ctx, cached);
			}, REARM_DELAY_MS);
		}, EDITOR_SETTLE_MS);
	}

	pi.registerShortcut(ACCEPT_SHORTCUT, {
		description: "Accept next-prompt suggestion",
		handler: (ctx) => {
			if (!suggestion) return;
			const accepted = suggestion;
			clearSuggestion(ctx);
			ctx.ui.setEditorText(accepted);
		},
	});

	pi.registerCommand("suggestions", {
		description: "Control next-prompt suggestions (on|off|status|model)",
		handler: async (args, ctx) => {
			const input = args.trim();
			const [rawAction = "", ...remainder] = input.split(/\s+/);
			const action = rawAction.toLowerCase();
			if (action === "on") {
				enabled = true;
				ctx.ui.notify("Next-prompt suggestions enabled.", "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				clearSuggestion(ctx);
				ctx.ui.notify("Next-prompt suggestions disabled.", "info");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(
					`Next-prompt suggestions are ${enabled ? "enabled" : "disabled"}. Model: ${modelSpec}. Last outcome: ${lastOutcome}.`,
					"info",
				);
				return;
			}
			if (action === "model") {
				const modelArgument = remainder.join(" ");
				if (!modelArgument) {
					ctx.ui.notify(`Suggestion model: ${modelSpec}.`, "info");
					return;
				}
				const requested =
					modelArgument.toLowerCase() === "reset"
						? defaultModelSpec
						: normalizeModelSpec(modelArgument);
				const model =
					requested === "current"
						? ctx.model
						: requested
							? ctx.models.resolve(requested)
							: undefined;
				if (!requested || !model) {
					ctx.ui.notify(
						`Suggestion model "${modelArgument}" is unavailable.`,
						"warning",
					);
					return;
				}
				modelSpec = requested;
				clearSuggestion(ctx);
				ctx.ui.notify(`Suggestion model set to ${modelSpec}.`, "info");
				return;
			}
			ctx.ui.notify(
				"Usage: /suggestions on|off|status|model [smol|slow|current|@role|provider/model|reset]",
				"warning",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const flagValue = pi.getFlag(MODEL_FLAG);
		defaultModelSpec = configuredModelSpec(
			typeof flagValue === "string" ? flagValue : undefined,
			process.env[MODEL_ENVIRONMENT_VARIABLE],
		);
		modelSpec = defaultModelSpec;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			if (
				(!suggestion && !generationAbort && !lastSuggestion) ||
				ACCEPT_INPUTS[data] ||
				isKnownNonEditingInput(data)
			)
				return undefined;
			const editorTextBefore = ctx.ui.getEditorText();
			if (editorTextBefore.length === 0) {
				scheduleEditorCheck(ctx, editorTextBefore);
				return undefined;
			}
			clearSuggestion(ctx, {
				forgetLast: false,
				outcome: generationAbort
					? "aborted: editor changed"
					: "dismissed: editor changed",
			});
			scheduleEditorCheck(ctx, editorTextBefore);
			return undefined;
		});
	});

	pi.on("agent_start", async (_event, ctx) => {
		clearSuggestion(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		clearSuggestion(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!enabled) {
			lastOutcome = "skipped: disabled";
			return;
		}
		if (!ctx.hasUI) {
			lastOutcome = "skipped: no interactive UI";
			return;
		}
		if (event.willContinue) {
			lastOutcome = "skipped: agent will continue";
			return;
		}
		if (ctx.hasPendingMessages()) {
			lastOutcome = "skipped: queued message";
			return;
		}
		if (ctx.ui.getEditorText().length > 0) {
			lastOutcome = "skipped: editor is not empty";
			return;
		}
		const suggestionContext = buildSuggestionContext(event.messages);
		if (!suggestionContext) {
			lastOutcome = "skipped: no eligible completed assistant turn";
			return;
		}
		const model =
			modelSpec === "current" ? ctx.model : ctx.models.resolve(modelSpec);
		if (!model) {
			lastOutcome = `skipped: model "${modelSpec}" is unavailable`;
			pi.logger.debug(
				`Next-prompt suggestion skipped: model "${modelSpec}" is unavailable`,
			);
			return;
		}

		clearSuggestion(ctx);
		lastOutcome = "generating";
		const requestGeneration = generation;
		const controller = new AbortController();
		generationAbort = controller;
		const timeoutSignal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
		const signal = AbortSignal.any([controller.signal, timeoutSignal]);

		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: [SYSTEM_PROMPT],
					messages: [
						{
							role: "user",
							content: suggestionContext.prompt,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: ctx.modelRegistry.resolver(
						model,
						ctx.sessionManager.getSessionId(),
					),
					disableReasoning: true,
					maxTokens: 128,
					signal,
				},
			);
			if (requestGeneration !== generation || !enabled) return;
			if (response.stopReason !== "stop") {
				lastOutcome = `no usable model output: ${response.stopReason}`;
				return;
			}
			if (!ctx.isIdle()) {
				lastOutcome = "discarded: agent is active";
				return;
			}
			if (ctx.hasPendingMessages()) {
				lastOutcome = "discarded: queued message";
				return;
			}
			if (ctx.ui.getEditorText().length > 0) {
				lastOutcome = "discarded: editor changed";
				return;
			}
			const value = normalizeSuggestion(contentText(response.content));
			if (value) {
				showSuggestion(ctx, value);
			} else {
				lastOutcome = "no usable model output";
			}
		} catch (error) {
			if (timeoutSignal.aborted && !controller.signal.aborted) {
				lastOutcome = "timed out";
			} else if (!signal.aborted) {
				lastOutcome = "failed";
				pi.logger.debug("Next-prompt suggestion generation failed", {
					error: String(error),
				});
			}
		} finally {
			if (generationAbort === controller) generationAbort = undefined;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearSuggestion(ctx);
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	});
}
