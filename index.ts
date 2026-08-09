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
	let generation = 0;
	let generationAbort: AbortController | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;

	pi.setLabel("Next-prompt suggestions");

	function clearSuggestion(
		ctx: ExtensionContext,
		abortGeneration = true,
	): void {
		generation += 1;
		suggestion = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (abortGeneration) {
			generationAbort?.abort();
			generationAbort = undefined;
		}
	}

	function showSuggestion(ctx: ExtensionContext, value: string): void {
		suggestion = value;
		ctx.ui.setWidget(
			WIDGET_KEY,
			[
				ctx.ui.theme.fg("dim", `Suggestion: ${value}`) +
					ctx.ui.theme.fg("muted", "  Alt+/ to accept"),
			],
			{ placement: "belowEditor" },
		);
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
					`Next-prompt suggestions are ${enabled ? "enabled" : "disabled"}. Model: ${modelSpec}.`,
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
			if ((!suggestion && !generationAbort) || ACCEPT_INPUTS[data])
				return undefined;
			clearSuggestion(ctx);
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
		if (
			!enabled ||
			!ctx.hasUI ||
			event.willContinue ||
			ctx.hasPendingMessages()
		)
			return;
		const suggestionContext = buildSuggestionContext(event.messages);
		if (!suggestionContext) return;
		const model =
			modelSpec === "current" ? ctx.model : ctx.models.resolve(modelSpec);
		if (!model) {
			pi.logger.debug(
				`Next-prompt suggestion skipped: model "${modelSpec}" is unavailable`,
			);
			return;
		}

		clearSuggestion(ctx);
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
			if (
				requestGeneration !== generation ||
				response.stopReason !== "stop" ||
				!enabled ||
				!ctx.isIdle() ||
				ctx.hasPendingMessages()
			)
				return;
			const value = normalizeSuggestion(contentText(response.content));
			if (value) showSuggestion(ctx, value);
		} catch (error) {
			if (!signal.aborted) {
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
