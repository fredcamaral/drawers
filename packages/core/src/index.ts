export const VERSION = "0.0.0";

export type { CompletionConfig, TerminalStatus } from "./completion";
export type {
	AcquireResult,
	ConcurrencyConfig,
	SlotHolder,
} from "./concurrency";
export { ConcurrencyManager, WaiterCancelledError } from "./concurrency";
export type { IdGenerator, IdGeneratorOptions } from "./ids";
export { createIdGenerator } from "./ids";
export type {
	NotificationQueue,
	NotificationQueueOpts,
	TaskNotice,
} from "./notify";
export { createNotificationQueue } from "./notify";
export type {
	FsFacade,
	TaskStore,
	TaskStoreLogger,
	TaskStoreOptions,
} from "./persistence";
export { createTaskStore } from "./persistence";
export type {
	EngineClient,
	PersistFn,
	SessionRunnerConfig,
	SessionRunnerDeps,
} from "./session-runner";
export { createSessionRunner } from "./session-runner";
export type {
	BgTask,
	Clock,
	LaunchRequest,
	ReadOpts,
	SessionRunner,
	TaskOutput,
	TaskStatus,
} from "./types";
export {
	isTerminal,
	TERMINAL_STATUSES,
} from "./types";
