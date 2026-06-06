/**
 * `bg_output` — read a background task's result, optionally blocking until it
 * finishes.
 *
 * The tool is built with a factory so tests inject a fake {@link SessionRunner}
 * without the SDK. All failure modes the model can reason over are returned as
 * honest strings (never a fake success); only genuinely unexpected conditions
 * would throw — and the runner surfaces unknown-id as a thrown error which we
 * translate to a string here, so in practice this tool does not throw.
 */

import type { SessionRunner, TaskOutput } from "@drawers/core";
import { type ToolContext, tool } from "@opencode-ai/plugin";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/** Marker prefix the completion gate uses for an awaitCompletion timeout. */
const TIMEOUT_MARKER = "awaitCompletion timeout";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Wait for terminal status, honouring `context.abort`. Returns a discriminated
 * result instead of throwing so the caller maps each case to a string.
 *
 * The abort race uses a single `abort` listener that is ALWAYS removed in the
 * finally block (verified by the abort test) — no leaked listeners regardless
 * of which branch wins.
 */
type BlockResult =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "timeout" }
	| { kind: "error"; message: string };

async function blockUntilDone(
	runner: SessionRunner,
	taskId: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<BlockResult> {
	if (signal.aborted) {
		return { kind: "aborted" };
	}

	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<BlockResult>((resolve) => {
		onAbort = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
	});

	try {
		return await Promise.race([
			runner.awaitCompletion(taskId, timeoutMs).then(
				(): BlockResult => ({ kind: "completed" }),
				(err: unknown): BlockResult => {
					const message = errorMessage(err);
					return message.startsWith(TIMEOUT_MARKER)
						? { kind: "timeout" }
						: { kind: "error", message };
				},
			),
			abortPromise,
		]);
	} finally {
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

/** Render a status line + summary, optionally appending the fenced transcript. */
function render(taskId: string, output: TaskOutput, full: boolean): string {
	const summary = output.summaryText.trim();
	const head = `task ${taskId} — ${output.status}`;
	const body = summary.length > 0 ? `${head}\n\n${summary}` : head;
	if (!full || !output.messages || output.messages.length === 0) {
		return body;
	}
	const transcript = output.messages
		.map((m) => {
			const text = m.parts.map((p) => p.text).join("\n");
			return `[${m.role}]\n${text}`;
		})
		.join("\n\n");
	return `${body}\n\nfull transcript:\n\`\`\`\n${transcript}\n\`\`\``;
}

export function createBgOutputTool(runner: SessionRunner) {
	return tool({
		description:
			"Read the result of a background task by id. Call this when notified " +
			"that a task completed — do NOT poll. Set block=true to wait for an " +
			"in-progress task to finish (bounded by timeout_ms); set full=true to " +
			"include the task's full transcript.",
		args: {
			task_id: tool.schema.string().describe("the bg_ task id to read"),
			full: tool.schema
				.boolean()
				.default(false)
				.describe("append the full filtered transcript"),
			block: tool.schema
				.boolean()
				.default(false)
				.describe("wait for the task to finish before reading"),
			timeout_ms: tool.schema
				.number()
				.default(DEFAULT_TIMEOUT_MS)
				.describe(
					`max ms to block (clamped to ${MAX_TIMEOUT_MS}); only used when block=true`,
				),
		},
		async execute(args, context: ToolContext) {
			const { task_id, full, block } = args;
			const timeoutMs = Math.min(Math.max(args.timeout_ms, 0), MAX_TIMEOUT_MS);

			if (block) {
				const blocked = await blockUntilDone(
					runner,
					task_id,
					timeoutMs,
					context.abort,
				);
				switch (blocked.kind) {
					case "aborted":
						return "wait cancelled";
					case "timeout":
						return (
							`task ${task_id} still running after ${timeoutMs}ms — do not ` +
							"retry immediately; you will be notified on completion"
						);
					case "error":
						return `cannot read task ${task_id}: ${blocked.message}`;
					case "completed":
						break;
				}
			}

			try {
				const output = await runner.readOutput(task_id, { full });
				return render(task_id, output, full);
			} catch (err) {
				return `cannot read task ${task_id}: ${errorMessage(err)}`;
			}
		},
	});
}
