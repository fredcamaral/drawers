import * as acorn from "acorn";

/**
 * Parses a workflow script's mandatory `meta` header (spec §3.1-3.2).
 *
 * A workflow script is plain JavaScript — TypeScript syntax must fail to parse —
 * and must begin with a single `export const meta = {...}` whose initializer is a
 * PURE literal: no variable references, calls, spreads, interpolation, or unary
 * operators. This module enforces that contract statically (acorn AST walk, never
 * `eval`) so the body never runs unless the metadata is trustworthy, and returns
 * the body with the meta statement blanked out so downstream error line numbers
 * still map onto the original source.
 */

/** A single phase entry inside `meta.phases`. */
export interface WorkflowPhase {
	title: string;
	detail?: string;
	model?: string;
}

/** The validated, materialized `meta` export of a workflow script. */
export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowPhase[];
}

/** Result of parsing a script: validated metadata plus the runnable body. */
export interface ParsedScript {
	meta: WorkflowMeta;
	/**
	 * The original source with the `export const meta` statement replaced by
	 * whitespace of equal length (newlines preserved), so body line/column
	 * numbers remain identical to the original script.
	 */
	bodySource: string;
}

/** The script is not valid JavaScript (or uses TypeScript syntax). */
export class ScriptSyntaxError extends Error {
	/** Character offset reported by acorn, when available. */
	readonly pos?: number;

	constructor(message: string, pos?: number) {
		super(message);
		this.name = "ScriptSyntaxError";
		this.pos = pos;
	}
}

/** The `meta` export is missing, impure, or fails validation. */
export class MetaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MetaError";
	}
}

/** A JSON-like value materialized from a pure-literal AST node. */
type LiteralValue =
	| string
	| number
	| boolean
	| null
	| LiteralValue[]
	| { [key: string]: LiteralValue };

/**
 * Parses a workflow script source into its validated `meta` and blanked body.
 *
 * @throws {ScriptSyntaxError} when the source is not parseable as a JS module.
 * @throws {MetaError} when the `meta` export is missing, impure, or invalid.
 */
export function parseScript(source: string): ParsedScript {
	const program = parseModule(source);

	let metaNode: acorn.ExportNamedDeclaration | undefined;

	for (const node of program.body) {
		if (node.type === "ImportDeclaration") {
			throw new MetaError(
				`workflow scripts are self-contained — no imports/exports beyond meta (at position ${node.start})`,
			);
		}
		if (
			node.type === "ExportDefaultDeclaration" ||
			node.type === "ExportAllDeclaration"
		) {
			throw new MetaError(
				`workflow scripts are self-contained — no imports/exports beyond meta (at position ${node.start})`,
			);
		}
		if (node.type === "ExportNamedDeclaration") {
			if (isMetaExport(node)) {
				if (metaNode) {
					throw new MetaError(
						`workflow scripts are self-contained — no imports/exports beyond meta (at position ${node.start})`,
					);
				}
				metaNode = node;
			} else {
				throw new MetaError(
					`workflow scripts are self-contained — no imports/exports beyond meta (at position ${node.start})`,
				);
			}
		}
	}

	if (!metaNode) {
		throw new MetaError("script must begin with export const meta = {...}");
	}

	const init = metaInitializer(metaNode);
	const value = materialize(walkPure(init));
	const meta = validateMeta(value);
	const bodySource = blankRange(source, metaNode.start, metaNode.end);

	return { meta, bodySource };
}

/** Parses the source as an ES module, mapping acorn failures to ScriptSyntaxError. */
function parseModule(source: string): acorn.Program {
	try {
		return acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "module",
			// The body's top-level `return` becomes the workflow result (spec §3.1,
			// §3.3) and is evaluated inside an AsyncFunction by evaluate.ts. Allowing
			// it here lets the SAME source parse as a module (for the meta header)
			// without rejecting the body's `return`.
			allowReturnOutsideFunction: true,
		});
	} catch (err) {
		if (err instanceof SyntaxError) {
			const pos = (err as SyntaxError & { pos?: number }).pos;
			throw new ScriptSyntaxError(err.message, pos);
		}
		throw err;
	}
}

/** True when the export declares exactly `const meta = <expr>`. */
function isMetaExport(node: acorn.ExportNamedDeclaration): boolean {
	const decl = node.declaration;
	if (decl?.type !== "VariableDeclaration") return false;
	if (decl.kind !== "const") return false;
	if (decl.declarations.length !== 1) return false;
	const [declarator] = decl.declarations;
	return (
		declarator !== undefined &&
		declarator.id.type === "Identifier" &&
		declarator.id.name === "meta"
	);
}

/** Extracts the initializer expression of the `meta` declarator. */
function metaInitializer(node: acorn.ExportNamedDeclaration): acorn.Expression {
	// isMetaExport already guaranteed the shape below.
	const decl = node.declaration as acorn.VariableDeclaration;
	const declarator = decl.declarations[0] as acorn.VariableDeclarator;
	if (!declarator.init) {
		throw new MetaError("script must begin with export const meta = {...}");
	}
	if (declarator.init.type !== "ObjectExpression") {
		throw new MetaError(
			`meta must be an object literal, found ${declarator.init.type} (at position ${declarator.init.start})`,
		);
	}
	return declarator.init;
}

/**
 * Verifies that an expression is a pure literal and returns it unchanged.
 * Allowed: ObjectExpression (non-computed Identifier/string keys),
 * ArrayExpression, and Literal of string/number/boolean/null. Everything else
 * (Identifier, CallExpression, SpreadElement, TemplateLiteral, UnaryExpression,
 * …) is rejected with a MetaError naming the construct and its position.
 */
function walkPure(node: acorn.Expression): acorn.Expression {
	switch (node.type) {
		case "Literal": {
			const v = node.value;
			if (
				typeof v === "string" ||
				typeof v === "number" ||
				typeof v === "boolean" ||
				v === null
			) {
				return node;
			}
			throw new MetaError(
				`meta may only contain string/number/boolean/null literals, found ${describeLiteral(v)} (at position ${node.start})`,
			);
		}
		case "ArrayExpression": {
			for (const element of node.elements) {
				if (element === null) {
					throw new MetaError(
						`meta arrays may not contain holes (at position ${node.start})`,
					);
				}
				if (element.type === "SpreadElement") {
					throw new MetaError(
						`meta may not use SpreadElement (at position ${element.start})`,
					);
				}
				walkPure(element);
			}
			return node;
		}
		case "ObjectExpression": {
			for (const prop of node.properties) {
				if (prop.type === "SpreadElement") {
					throw new MetaError(
						`meta may not use SpreadElement (at position ${prop.start})`,
					);
				}
				if (prop.computed) {
					throw new MetaError(
						`meta object keys may not be computed (at position ${prop.start})`,
					);
				}
				if (
					prop.key.type !== "Identifier" &&
					!(prop.key.type === "Literal" && typeof prop.key.value === "string")
				) {
					throw new MetaError(
						`meta object keys must be identifiers or string literals, found ${prop.key.type} (at position ${prop.key.start})`,
					);
				}
				walkPure(prop.value as acorn.Expression);
			}
			return node;
		}
		default:
			throw new MetaError(
				`meta may not use ${node.type} (at position ${node.start})`,
			);
	}
}

/** Converts a pure-literal AST (already validated by walkPure) into a JS value. */
function materialize(node: acorn.Expression): LiteralValue {
	switch (node.type) {
		case "Literal":
			return node.value as string | number | boolean | null;
		case "ArrayExpression":
			return node.elements.map((element) =>
				// walkPure rejected holes and spreads, so element is an Expression.
				materialize(element as acorn.Expression),
			);
		case "ObjectExpression": {
			const obj: { [key: string]: LiteralValue } = {};
			for (const prop of node.properties) {
				const property = prop as acorn.Property;
				const key =
					property.key.type === "Identifier"
						? property.key.name
						: String((property.key as acorn.Literal).value);
				obj[key] = materialize(property.value as acorn.Expression);
			}
			return obj;
		}
		default:
			// Unreachable: walkPure has already rejected every other node type.
			throw new MetaError(`meta may not use ${node.type}`);
	}
}

/** Validates the materialized literal against the WorkflowMeta contract. */
function validateMeta(value: LiteralValue): WorkflowMeta {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MetaError("meta must be an object literal");
	}

	const name = value.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new MetaError("meta.name must be a non-empty string");
	}

	const description = value.description;
	if (typeof description !== "string" || description.length === 0) {
		throw new MetaError("meta.description must be a non-empty string");
	}

	const meta: WorkflowMeta = { name, description };

	if (value.whenToUse !== undefined) {
		if (typeof value.whenToUse !== "string") {
			throw new MetaError("meta.whenToUse must be a string");
		}
		meta.whenToUse = value.whenToUse;
	}

	if (value.phases !== undefined) {
		if (!Array.isArray(value.phases)) {
			throw new MetaError("meta.phases must be an array");
		}
		meta.phases = value.phases.map((entry, index) =>
			validatePhase(entry, index),
		);
	}

	return meta;
}

/** Validates a single `meta.phases` entry. */
function validatePhase(value: LiteralValue, index: number): WorkflowPhase {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MetaError(`meta.phases[${index}] must be an object`);
	}
	const title = value.title;
	if (typeof title !== "string" || title.length === 0) {
		throw new MetaError(
			`meta.phases[${index}].title must be a non-empty string`,
		);
	}
	const phase: WorkflowPhase = { title };
	if (value.detail !== undefined) {
		if (typeof value.detail !== "string") {
			throw new MetaError(`meta.phases[${index}].detail must be a string`);
		}
		phase.detail = value.detail;
	}
	if (value.model !== undefined) {
		if (typeof value.model !== "string") {
			throw new MetaError(`meta.phases[${index}].model must be a string`);
		}
		phase.model = value.model;
	}
	return phase;
}

/**
 * Replaces `source[start, end)` with whitespace of equal length, preserving any
 * newlines so the body retains its original line/column mapping.
 */
function blankRange(source: string, start: number, end: number): string {
	const blanked = source.slice(start, end).replace(/[^\n]/g, " ");
	return source.slice(0, start) + blanked + source.slice(end);
}

/** Human-readable label for an unsupported literal value. */
function describeLiteral(value: unknown): string {
	if (value instanceof RegExp) return "RegExp";
	if (typeof value === "bigint") return "BigInt";
	return typeof value;
}
