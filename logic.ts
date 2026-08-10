const MAX_SUGGESTION_CHARS = 100;
const MAX_SUGGESTION_WORDS = 12;
const MAX_CONTEXT_CHARS = 10_000;
const DEFAULT_MODEL_SPEC = "@smol";
const MODEL_LEVELS: Record<string, string> = {
	default: "current",
	main: "current",
	current: "current",
	smol: "@smol",
	slow: "@slow",
};

export const SUGGESTION_RENDER_MODES = ["widget", "ghost", "both"] as const;
export type SuggestionRenderMode = (typeof SUGGESTION_RENDER_MODES)[number];

export function normalizeRenderMode(
	value: string | undefined,
): SuggestionRenderMode | undefined {
	const mode = value?.trim().toLowerCase();
	return SUGGESTION_RENDER_MODES.find((candidate) => candidate === mode);
}

export function configuredRenderMode(
	cliValue: string | undefined,
	environmentValue: string | undefined,
	persistedValue?: string,
): SuggestionRenderMode {
	return (
		normalizeRenderMode(cliValue) ??
		normalizeRenderMode(environmentValue) ??
		normalizeRenderMode(persistedValue) ??
		"widget"
	);
}

export function normalizeModelSpec(
	value: string | undefined,
): string | undefined {
	const spec = value?.trim();
	if (!spec) return undefined;
	return MODEL_LEVELS[spec.toLowerCase()] ?? spec;
}

export function configuredModelSpec(
	cliValue: string | undefined,
	environmentValue: string | undefined,
): string {
	return (
		normalizeModelSpec(cliValue) ??
		normalizeModelSpec(environmentValue) ??
		DEFAULT_MODEL_SPEC
	);
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
}

export interface SuggestionContext {
	prompt: string;
	userMessageCount: number;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((block) => {
			if (typeof block !== "object" || block === null) return [];
			if (
				!("type" in block) ||
				block.type !== "text" ||
				!("text" in block) ||
				typeof block.text !== "string"
			) {
				return [];
			}
			return [block.text];
		})
		.join("\n")
		.trim();
}

export function normalizeSuggestion(output: string): string | undefined {
	const suggestion = output
		.trim()
		.replace(/^```(?:text|markdown)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim()
		.replace(/^(["'`])([\s\S]+)\1$/, "$2")
		.trim();
	if (!suggestion || shouldFilterSuggestion(suggestion)) return undefined;
	return suggestion;
}

export function shouldFilterSuggestion(suggestion: string): boolean {
	const lower = suggestion.toLowerCase();
	const wordCount = suggestion.split(/\s+/).length;
	const allowedSingleWords: Record<string, true> = {
		yes: true,
		yeah: true,
		yep: true,
		yea: true,
		yup: true,
		sure: true,
		ok: true,
		okay: true,
		push: true,
		commit: true,
		deploy: true,
		stop: true,
		continue: true,
		check: true,
		exit: true,
		quit: true,
		no: true,
	};

	return (
		lower === "done" ||
		lower === "none" ||
		lower === "none." ||
		lower === "n/a" ||
		lower === "nothing found" ||
		lower === "nothing found." ||
		lower.startsWith("nothing to suggest") ||
		lower.startsWith("no suggestion") ||
		/\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
		/^\W*silence\W*$/.test(lower) ||
		/^\(.*\)$|^\[.*\]$/.test(suggestion) ||
		lower.startsWith("api error:") ||
		lower.startsWith("prompt is too long") ||
		lower.startsWith("request timed out") ||
		lower.startsWith("invalid api key") ||
		lower.startsWith("image was too large") ||
		/^\w+:\s/.test(suggestion) ||
		(wordCount < 2 &&
			!suggestion.startsWith("/") &&
			!allowedSingleWords[lower]) ||
		wordCount > MAX_SUGGESTION_WORDS ||
		suggestion.length >= MAX_SUGGESTION_CHARS ||
		/[.!?]\s+[A-Z]/.test(suggestion) ||
		/[\n*]|\*\*/.test(suggestion) ||
		/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
			lower,
		) ||
		/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
			suggestion,
		)
	);
}

export function buildSuggestionContext(
	messages: readonly unknown[],
): SuggestionContext | undefined {
	const conversation: Array<{ role: "User" | "Assistant"; text: string }> = [];
	let userMessageCount = 0;
	let lastAssistant: MessageLike | undefined;

	for (const value of messages) {
		const message = value as MessageLike;
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		if (message.role === "user") {
			userMessageCount += 1;
		} else {
			lastAssistant = message;
		}
		const text = contentText(message.content);
		if (text) {
			conversation.push({
				role: message.role === "user" ? "User" : "Assistant",
				text,
			});
		}
	}

	if (
		userMessageCount < 1 ||
		!lastAssistant ||
		lastAssistant.stopReason === "error" ||
		typeof lastAssistant.errorMessage === "string"
	) {
		return undefined;
	}

	const originalRequestIndex = conversation.findIndex(
		(entry) => entry.role === "User",
	);
	const originalRequest = conversation[originalRequestIndex];
	if (!originalRequest || conversation.at(-1)?.role !== "Assistant")
		return undefined;

	const recent: string[] = [];
	let recentLength = 0;
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const entry = conversation[index];
		if (!entry) continue;
		if (index === originalRequestIndex) continue;
		const text = truncateMiddle(
			entry.text,
			entry.role === "Assistant" ? 6_000 : 2_500,
		);
		const rendered = `${entry.role}: ${text}`;
		if (recent.length > 0 && recentLength + rendered.length > MAX_CONTEXT_CHARS)
			break;
		recent.push(rendered);
		recentLength += rendered.length;
	}
	recent.reverse();

	return {
		userMessageCount,
		prompt: `Original user request:\n${truncateMiddle(originalRequest.text, 2_500)}\n\nRecent conversation:\n${recent.join("\n\n")}`,
	};
}

function truncateMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const half = Math.floor((maxLength - 7) / 2);
	return `${value.slice(0, half)}\n[...]\n${value.slice(-half)}`;
}
