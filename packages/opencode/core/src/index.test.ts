import { expect, test } from "bun:test";
import {
	adaptSdkClient,
	createIdGenerator,
	createNotificationQueue,
	createSessionRunner,
	createTaskStore,
	createWakeNotifier,
	humanizeDuration,
	isValidTask,
	nodeFsFacade,
} from "./index";

test("toolchain runs and core exposes its factory surface", () => {
	expect(typeof createTaskStore).toBe("function");
	expect(typeof createNotificationQueue).toBe("function");
	expect(typeof createSessionRunner).toBe("function");
	expect(typeof createWakeNotifier).toBe("function");
	expect(typeof createIdGenerator).toBe("function");
	expect(typeof adaptSdkClient).toBe("function");
	expect(typeof isValidTask).toBe("function");
	expect(typeof nodeFsFacade).toBe("function");
	expect(typeof humanizeDuration).toBe("function");
});
