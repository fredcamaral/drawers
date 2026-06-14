// Saved sub-workflow used by the live e2e harness (Task 4.3.2).
//
// scenario A's inline parent calls `await workflow('helper', { x: 1 })`, exercising
// saved-name resolution (.opencode/workflows/<name>.js) AND the sub-workflow
// boundary end-to-end. The child runs ONE agent and returns a marker the harness
// asserts on. Kept tiny: one agent, deterministic prompt, literal return shape.
export const meta = {
	name: "helper",
	description: "A one-agent saved sub-workflow returning a marker.",
};

const reply = await agent("Reply with exactly: helper-marker", {
	label: "helper-agent",
	phase: "Helper",
});

return { marker: reply, x: args && args.x };
