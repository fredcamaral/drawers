/**
 * `bg_output` — read a background task's result, optionally blocking until it
 * finishes.
 *
 * pi port. Factory-DI on a {@link SessionRunner} thunk. All failure modes the
 * model can reason over are RETURNED as model-readable text (never a thrown
 * error, never a fake success); the runner's unknown-id throw is translated to a
 * string here, so in practice this tool does not throw.
 *
 * pi changes vs opencode:
 *   - the abort source is the `signal` execute param (may be `undefined` when not
 *     in an active turn — gotcha #7), not `context.abort`;
 *   - the rendered output is truncated with `truncateTail` (gotcha #6) before
 *     return, telling the model where the full transcript is.
 *
 * Node-safe: no Bun.* APIs.
 */

import type { SessionRunner, TaskOutput } from "@drawers/pi-core";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/** Marker prefix the completion fuser uses for an awaitCompletion timeout. */
const TIMEOUT_MARKER = "awaitCompletion timeout";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

type BlockResult =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "timeout" }
	| { kind: "error"; message: string };

/**
 * Wait for terminal status, honouring an optional abort `signal`. Returns a
 * discriminated result instead of throwing so the caller maps each case to a
 * string. The abort listener is ALWAYS removed in `finally` — no leak regardless
 * of which branch wins. A `undefined` signal means no abort race (idle context).
 */
async function blockUntilDone(
	runner: SessionRunner,
	taskId: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<BlockResult> {
	if (signal?.aborted) {
		return { kind: "aborted" };
	}

	const completion = runner.awaitCompletion(taskId, timeoutMs).then(
		(): BlockResult => ({ kind: "completed" }),
		(err: unknown): BlockResult => {
			const message = errorMessage(err);
			return message.startsWith(TIMEOUT_MARKER)
				? { kind: "timeout" }
				: { kind: "error", message };
		},
	);

	if (!signal) {
		return completion;
	}

	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<BlockResult>((resolve) => {
		onAbort = () => resolve({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([completion, abortPromise]);
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
			// A part may carry no `text`; coalesce to "" so the transcript never
			// leaks the literal string "undefined".
			const partText = m.parts.map((p) => p.text ?? "").join("\n");
			return `[${m.role}]\n${partText}`;
		})
		.join("\n\n");
	return `${body}\n\nfull transcript:\n\`\`\`\n${transcript}\n\`\`\``;
}

/** Cap the final string for the model (gotcha #6); name where the rest went. */
function cap(rendered: string): string {
	const t = truncateTail(rendered, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!t.truncated) {
		return t.content;
	}
	return (
		`${t.content}\n\n[truncated: kept ${t.outputLines}/${t.totalLines} lines ` +
		`(${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). ` +
		`Re-read with full=false for just the summary.]`
	);
}

export function createBgOutputTool(getRunner: () => SessionRunner) {
	return defineTool({
		name: "bg_output",
		label: "Background output",
		description:
			"Read the result of a background task by id. Call this when notified " +
			"that a task completed — do NOT poll. Set block=true to wait for an " +
			"in-progress task to finish (bounded by timeout_ms); set full=true to " +
			"include the task's full transcript.",
		promptSnippet: "Read a background task's result by id",
		parameters: Type.Object({
			task_id: Type.String({ description: "the bg_ task id to read" }),
			full: Type.Optional(
				Type.Boolean({ description: "append the full filtered transcript" }),
			),
			block: Type.Optional(
				Type.Boolean({
					description: "wait for the task to finish before reading",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description: `max ms to block (clamped to ${MAX_TIMEOUT_MS}); only used when block=true`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const runner = getRunner();
			const taskId = typeof params.task_id === "string" ? params.task_id : "";
			if (taskId.length === 0) {
				return text("cannot read task: `task_id` is required");
			}
			const full = params.full === true;
			const block = params.block === true;

			// pi does not apply schema defaults to raw incoming values (gotcha #4):
			// `timeout_ms` can arrive undefined/NaN. A NaN would reach the fuser's
			// timer as setTimeout(cb, NaN) → fires after ~1ms → block returns "still
			// running" instantly. Coerce defensively: non-finite → the default.
			const rawTimeout = params.timeout_ms;
			const timeoutMs = Math.min(
				Math.max(
					typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
						? rawTimeout
						: DEFAULT_TIMEOUT_MS,
					0,
				),
				MAX_TIMEOUT_MS,
			);

			if (block) {
				const blocked = await blockUntilDone(runner, taskId, timeoutMs, signal);
				switch (blocked.kind) {
					case "aborted":
						return text("wait cancelled");
					case "timeout":
						return text(
							`task ${taskId} still running after ${timeoutMs}ms — do not ` +
								"retry immediately; you will be notified on completion",
						);
					case "error":
						return text(`cannot read task ${taskId}: ${blocked.message}`);
					case "completed":
						break;
				}
			}

			try {
				const output = await runner.readOutput(taskId, { full });
				return text(cap(render(taskId, output, full)));
			} catch (err) {
				return text(`cannot read task ${taskId}: ${errorMessage(err)}`);
			}
		},
	});
}
