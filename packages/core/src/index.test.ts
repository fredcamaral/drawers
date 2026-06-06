import { expect, test } from "bun:test";
import { VERSION } from "./index";

test("toolchain runs and core module exports VERSION", () => {
	expect(VERSION).toBeDefined();
	expect(typeof VERSION).toBe("string");
});
