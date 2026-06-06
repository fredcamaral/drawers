/**
 * Public surface of the workflows package. Grows as later tasks land the
 * runtime, scheduler, and host integration.
 */

export {
	type AgentPrimitiveDeps,
	createAgentPrimitive,
} from "./runtime/agent-call";
export {
	ITEM_CAP,
	ItemCapError,
	type PipelineStage,
	parallel,
	pipeline,
} from "./runtime/compose";
export { DeterminismError, evaluateScript } from "./runtime/evaluate";
export {
	createWorkflowRun,
	type WorkflowResult,
	type WorkflowRun,
	type WorkflowRunDeps,
} from "./runtime/index";
export {
	MetaError,
	type ParsedScript,
	parseScript,
	ScriptSyntaxError,
	type WorkflowMeta,
	type WorkflowPhase,
} from "./runtime/meta";
export {
	createSchemaRegistry,
	type SchemaRegistry,
} from "./runtime/structured/registry";
export { createStructuredOutputTool } from "./runtime/structured/tool";
export {
	type CompiledSchema,
	compileSchema,
	SchemaCompileError,
} from "./runtime/structured/validate";
export {
	AgentCapError,
	type AgentFn,
	type AgentOpts,
	BudgetExhaustedError,
	type BudgetView,
	NotYetSupportedError,
	type ProgressEmitter,
	type ProgressEvent,
	type RuntimeApi,
} from "./runtime/types";
