import { describe, expect, test } from "bun:test";

import {
	buildSuggestionContext,
	configuredModelSpec,
	configuredRenderMode,
	normalizeModelSpec,
	normalizeRenderMode,
	normalizeSuggestion,
} from "./logic";

describe("normalizeSuggestion", () => {
	test("returns one clean prompt from valid model output", () => {
		expect(normalizeSuggestion('"Run the focused tests"')).toBe(
			"Run the focused tests",
		);
		expect(normalizeSuggestion("yes")).toBe("yes");
	});

	test("rejects meta, decorated, evaluative, and overlong output", () => {
		expect(normalizeSuggestion("  ")).toBeUndefined();
		expect(normalizeSuggestion("NONE")).toBeUndefined();
		expect(normalizeSuggestion("Suggestion: Run the tests")).toBeUndefined();
		expect(normalizeSuggestion("Looks good, thanks")).toBeUndefined();
		expect(normalizeSuggestion("x".repeat(100))).toBeUndefined();
		expect(
			normalizeSuggestion(
				"one two three four five six seven eight nine ten eleven twelve thirteen",
			),
		).toBeUndefined();
	});
});

describe("buildSuggestionContext", () => {
	test("includes the original request and latest exchange", () => {
		const messages = [
			{ role: "user", content: "Initial request" },
			{
				role: "assistant",
				content: [{ type: "text", text: "Initial answer" }],
			},
			{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
			{
				role: "user",
				content: [{ type: "text", text: "Fix the remaining issue" }],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "The issue is fixed and verified." },
				],
			},
		];

		const context = buildSuggestionContext(messages);
		expect(context?.userMessageCount).toBe(2);
		expect(context?.prompt).toContain(
			"Original user request:\nInitial request",
		);
		expect(context?.prompt.split("Initial request")).toHaveLength(2);
		expect(context?.prompt).toContain("User: Fix the remaining issue");
		expect(context?.prompt).toContain(
			"Assistant: The issue is fixed and verified.",
		);
		expect(context?.prompt).not.toContain("tool output");
	});

	test("generates after the first user exchange and skips failed responses", () => {
		const firstTurn = buildSuggestionContext([
			{ role: "user", content: "Request" },
			{ role: "assistant", content: "First answer" },
		]);
		expect(firstTurn?.userMessageCount).toBe(1);
		expect(firstTurn?.prompt).toContain("Assistant: First answer");
		expect(
			buildSuggestionContext([
				{ role: "user", content: "Request" },
				{ role: "assistant", content: "First answer" },
				{ role: "user", content: "Try again" },
				{
					role: "assistant",
					content: "Failed answer",
					stopReason: "error",
				},
			]),
		).toBeUndefined();
	});
});

describe("suggestion model selection", () => {
	test("accepts model levels and exact model specifications", () => {
		expect(normalizeModelSpec(" smol ")).toBe("@smol");
		expect(normalizeModelSpec("slow")).toBe("@slow");
		expect(normalizeModelSpec("default")).toBe("current");
		expect(normalizeModelSpec("CURRENT")).toBe("current");
		expect(normalizeModelSpec("anthropic/claude-sonnet-4-6")).toBe(
			"anthropic/claude-sonnet-4-6",
		);
		expect(normalizeModelSpec(" ")).toBeUndefined();
	});

	test("prefers the CLI flag, then the environment, then @smol", () => {
		expect(configuredModelSpec("@slow", "current")).toBe("@slow");
		expect(configuredModelSpec(undefined, "slow")).toBe("@slow");
		expect(configuredModelSpec(undefined, undefined)).toBe("@smol");
	});
});

describe("suggestion render mode selection", () => {
	test("accepts supported modes case-insensitively", () => {
		expect(normalizeRenderMode(" widget ")).toBe("widget");
		expect(normalizeRenderMode("GHOST")).toBe("ghost");
		expect(normalizeRenderMode("both")).toBe("both");
		expect(normalizeRenderMode("inline")).toBeUndefined();
		expect(normalizeRenderMode(" ")).toBeUndefined();
	});

	test("prefers the CLI flag, environment, saved setting, then widget", () => {
		expect(configuredRenderMode("ghost", "both", "widget")).toBe("ghost");
		expect(configuredRenderMode(undefined, "both", "ghost")).toBe("both");
		expect(configuredRenderMode(undefined, undefined, "ghost")).toBe("ghost");
		expect(configuredRenderMode(undefined, undefined, "invalid")).toBe("widget");
		expect(configuredRenderMode(undefined, undefined)).toBe("widget");
	});
});
