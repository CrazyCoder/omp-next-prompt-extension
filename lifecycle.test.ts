import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
	vi,
} from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

interface SuggestionResponse {
	stopReason: "stop";
	content: Array<{ type: "text"; text: string }>;
}

interface CompleteOptions {
	signal: AbortSignal;
}

const completeSimple = mock(
	async (
		_model: unknown,
		_context: unknown,
		_options: CompleteOptions,
	): Promise<SuggestionResponse> => suggestionResponse("run the focused tests"),
);
mock.module("@oh-my-pi/pi-ai", () => ({ completeSimple }));

// Dynamic import is required so Bun installs the pi-ai module mock before index.ts evaluates.
const { default: registerNextPrompt } = await import("./index");

type EventHandler = (
	event: Record<string, unknown>,
	ctx: unknown,
) => Promise<void>;
type TerminalInputHandler = (data: string) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

interface RegisteredShortcut {
	key: string;
	handler: (ctx: unknown) => void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}


function suggestionResponse(text: string): SuggestionResponse {
	return {
		stopReason: "stop",
		content: [{ type: "text", text }],
	};
}

function conversationMessages() {
	return [
		{ role: "user", content: "Fix the bug" },
		{ role: "assistant", content: "The bug is fixed" },
		{ role: "user", content: "Also update the test" },
		{ role: "assistant", content: "The test is updated" },
	];
}

function createHarness() {
	const handlers: Record<string, EventHandler> = {};
	const commands: Record<string, CommandHandler> = {};
	let terminalInput: TerminalInputHandler | undefined;
	let pendingMessages = false;
	let idle = true;
	let widget: unknown;
	let editorText = "";
	let notification = "";
	let shortcut: RegisteredShortcut | undefined;
	const model = { provider: "test", id: "suggestion-model" };
	const ctx = {
		hasUI: true,
		model,
		models: {
			resolve: () => model,
		},
		modelRegistry: {
			resolver: () => "test-api-key",
		},
		sessionManager: {
			getSessionId: () => "test-session",
		},
		hasPendingMessages: () => pendingMessages,
		isIdle: () => idle,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setWidget: (_key: string, value: unknown) => {
				widget = value;
			},
			onTerminalInput: (handler: TerminalInputHandler) => {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
			notify: (message: string) => {
				notification = message;
			},
		},
	};
	const pi = {
		registerFlag: () => {},
		getFlag: () => undefined,
		setLabel: () => {},
		registerShortcut: (
			key: string,
			options: { handler: (ctx: unknown) => void },
		) => {
			shortcut = { key, handler: options.handler };
		},
		registerCommand: (
			name: string,
			options: { handler: CommandHandler },
		) => {
			commands[name] = options.handler;
		},
		on: (event: string, handler: EventHandler) => {
			handlers[event] = handler;
		},
		logger: {
			debug: () => {},
		},
	};
	registerNextPrompt(pi as unknown as ExtensionAPI);

	return {
		ctx,
		handlers,
		commands,
		get terminalInput() {
			return terminalInput;
		},
		get widget() {
			return widget;
		},
		get editorText() {
			return editorText;
		},
		get notification() {
			return notification;
		},
		set editorText(value: string) {
			editorText = value;
		},
		get shortcut() {
			return shortcut;
		},
		set pendingMessages(value: boolean) {
			pendingMessages = value;
		},
		set idle(value: boolean) {
			idle = value;
		},
	};
}

beforeEach(() => {
	completeSimple.mockClear();
	completeSimple.mockImplementation(async () =>
		suggestionResponse("run the focused tests"),
	);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("next-prompt lifecycle", () => {
	test("registers Alt+/ and accepts all supported terminal encodings", async () => {
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);
		await harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);

		expect(harness.shortcut?.key).toBe("alt+/");
		for (const input of ["\x1b/", "\x1bO/", "\x1b[47;3u"]) {
			harness.terminalInput?.(input);
			expect(harness.widget).toEqual([
				"Suggestion: run the focused tests  Alt+/ to accept",
			]);
		}

		harness.shortcut?.handler(harness.ctx);
		expect(harness.editorText).toBe("run the focused tests");
		expect(harness.widget).toBeUndefined();
	});

	test("suppresses continuation and pending-message settles", async () => {
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);

		await harness.handlers.agent_end?.(
			{ messages: conversationMessages(), willContinue: true },
			harness.ctx,
		);
		expect(completeSimple).not.toHaveBeenCalled();

		harness.pendingMessages = true;
		await harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("discards a completion only after terminal input changes the editor", async () => {
		vi.useFakeTimers();
		const generation = deferred<SuggestionResponse>();
		completeSimple.mockImplementation(() => generation.promise);
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);

		const request = harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);
		await Promise.resolve();
		expect(completeSimple).toHaveBeenCalledTimes(1);
		const options = completeSimple.mock.calls[0]?.[2];

		harness.terminalInput?.("x");
		expect(options?.signal.aborted).toBe(false);
		harness.editorText = "x";
		vi.advanceTimersByTime(50);
		expect(options?.signal.aborted).toBe(true);
		generation.resolve(suggestionResponse("commit the changes"));
		await request;
		expect(harness.widget).toBeUndefined();
	});

	test("keeps suggestions across focus, mouse, and navigation input", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);
		await harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);

		for (const input of [
			"\x1b[I",
			"\x1b[O",
			"\x1b[<0;12;4M",
			"\x1b[A",
			"\x1b[Z",
		]) {
			harness.terminalInput?.(input);
			vi.advanceTimersByTime(50);
			expect(harness.widget).toEqual([
				"Suggestion: run the focused tests  Alt+/ to accept",
			]);
		}
	});

	test("re-arms the cached suggestion after typed text is deleted", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);
		await harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);

		harness.terminalInput?.("x");
		harness.editorText = "x";
		vi.advanceTimersByTime(50);
		expect(harness.widget).toBeUndefined();

		harness.terminalInput?.("\x7f");
		harness.editorText = "";
		vi.advanceTimersByTime(2_049);
		expect(harness.widget).toBeUndefined();
		vi.advanceTimersByTime(1);
		expect(harness.widget).toEqual([
			"Suggestion: run the focused tests  Alt+/ to accept",
		]);
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	test("reports why no suggestion was shown", async () => {
		completeSimple.mockImplementation(async () => suggestionResponse("NONE"));
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);
		await harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);
		await harness.handlers.input?.({}, harness.ctx);

		await harness.commands.suggestions?.("status", harness.ctx);
		expect(harness.notification).toContain(
			"Last outcome: no usable model output.",
		);
	});

	test("keeps the newest suggestion when an older request finishes last", async () => {
		const first = deferred<SuggestionResponse>();
		const second = deferred<SuggestionResponse>();
		completeSimple
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		const harness = createHarness();
		await harness.handlers.session_start?.({}, harness.ctx);

		const oldRequest = harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);
		await Promise.resolve();
		await harness.handlers.agent_start?.({}, harness.ctx);
		const newRequest = harness.handlers.agent_end?.(
			{ messages: conversationMessages() },
			harness.ctx,
		);
		await Promise.resolve();

		second.resolve(suggestionResponse("run the latest tests"));
		await newRequest;
		expect(harness.widget).toEqual([
			"Suggestion: run the latest tests  Alt+/ to accept",
		]);

		first.resolve(suggestionResponse("commit the old changes"));
		await oldRequest;
		expect(harness.widget).toEqual([
			"Suggestion: run the latest tests  Alt+/ to accept",
		]);
	});
});
