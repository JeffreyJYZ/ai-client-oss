import * as ts from "typescript";
import type { DocField, DocSymbol } from "@/docs/types";

/**
 * Extract the public surface of a TypeScript module from its text. This is the
 * whole reason the reference cannot drift: every name, signature and member
 * below is printed from the source the app actually ships, never typed here.
 *
 * It is deliberately a syntax-only pass — no type checker, no program, no
 * `node_modules` — so it runs on one file at a time and cannot be confused by a
 * module whose dependencies are missing (a Phase 2 module mid-write has to be
 * documentable, or the docs build would break the deploy).
 */

/** A source reader: returns the file's text, or `null` when it does not exist. */
export type SourceReader = (path: string) => string | null;

const parse = (path: string, source: string): ts.SourceFile =>
	ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

const hasExportModifier = (node: ts.Node): boolean =>
	ts.canHaveModifiers(node) &&
	(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ??
		false);

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const nameText = (name: ts.Node | undefined, sf: ts.SourceFile): string => {
	if (name === undefined) return "";
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteralLike(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	return collapse(name.getText(sf));
};

/**
 * The whole doc comment, cut only if it is longer than `DESCRIPTION_CAP` — and
 * then at a sentence boundary, never mid-word.
 *
 * The reference is the deliverable, so a two-paragraph contract note (the
 * provider `buildRequest` idempotence requirement, say) has to reach the page in
 * full. An earlier cap cut to the **first sentence** of any comment over the
 * limit, which meant every second paragraph silently vanished; the fallback now
 * applies only past the cap. The cap matches the one on an interface signature
 * and no entry module's comment reaches it, so in practice descriptions ship
 * whole.
 */
const DESCRIPTION_CAP = 1600;

const summarise = (text: string): string => {
	const collapsed = collapse(text);
	if (collapsed.length <= DESCRIPTION_CAP) return collapsed;
	const sentence = /^.*?[.!?](?=\s|$)/.exec(collapsed)?.[0].trim() ?? "";
	if (sentence !== "" && sentence.length <= DESCRIPTION_CAP) return sentence;
	return truncate(collapsed, DESCRIPTION_CAP);
};

/** The last `/** … *​/` block immediately above `node`, as one line. */
const descriptionOf = (
	source: string,
	node: ts.Node,
	sf: ts.SourceFile,
): string => {
	const trivia = source.slice(node.getFullStart(), node.getStart(sf));
	const blocks = trivia.match(/\/\*\*[\s\S]*?\*\//g);
	if (blocks === null) return "";
	const block = blocks[blocks.length - 1] ?? "";
	const cleaned = block
		.replace(/^\/\*\*/, "")
		.replace(/\*\/$/, "")
		.split("\n")
		.map((line) => line.replace(/^\s*\*?\s?/, "").trim())
		.filter((line) => line !== "" && !line.startsWith("@"))
		.join(" ");
	return summarise(cleaned);
};

const memberNames = (
	members: readonly ts.Node[] | undefined,
	sf: ts.SourceFile,
): string[] => {
	if (members === undefined) return [];
	const names: string[] = [];
	for (const member of members) {
		if (
			ts.isPropertySignature(member) ||
			ts.isPropertyDeclaration(member) ||
			ts.isMethodSignature(member) ||
			ts.isMethodDeclaration(member)
		) {
			const name = nameText(member.name, sf);
			if (name !== "") names.push(name);
		}
	}
	return names;
};

const typeParamsText = (
	node: ts.Node & { readonly typeParameters?: ts.NodeArray<ts.Node> },
	sf: ts.SourceFile,
): string =>
	node.typeParameters === undefined
		? ""
		: `<${node.typeParameters.map((p) => collapse(p.getText(sf))).join(", ")}>`;

const signatureOfVariable = (
	kind: string,
	decl: ts.VariableDeclaration,
	sf: ts.SourceFile,
): string => {
	const name = nameText(decl.name, sf);
	const annotation =
		decl.type === undefined ? "" : `: ${collapse(decl.type.getText(sf))}`;
	const init = decl.initializer;
	if (init === undefined) return `export ${kind} ${name}${annotation};`;
	if (ts.isArrowFunction(init)) {
		const params = init.parameters
			.map((p) => collapse(p.getText(sf)))
			.join(", ");
		const returns =
			init.type === undefined ? "" : `: ${collapse(init.type.getText(sf))}`;
		return `export ${kind} ${name} = ${typeParamsText(init, sf)}(${params})${returns} => …`;
	}
	if (annotation !== "") return `export ${kind} ${name}${annotation};`;
	if (
		ts.isCallExpression(init) &&
		init.arguments.some((argument) => ts.isObjectLiteralExpression(argument))
	) {
		return `export ${kind} ${name} = ${collapse(init.expression.getText(sf))}({ … });`;
	}
	return `export ${kind} ${name} = ${truncate(collapse(init.getText(sf)), 140)};`;
};

const variableKeyword = (flags: ts.NodeFlags): string => {
	if ((flags & ts.NodeFlags.Const) !== 0) return "const";
	if ((flags & ts.NodeFlags.Let) !== 0) return "let";
	return "var";
};

const signatureOfFunction = (
	node: ts.FunctionDeclaration,
	sf: ts.SourceFile,
): string => {
	const name = nameText(node.name, sf) || "default";
	const params = node.parameters.map((p) => collapse(p.getText(sf))).join(", ");
	const returns =
		node.type === undefined ? "" : `: ${collapse(node.type.getText(sf))}`;
	return `export function ${name}${typeParamsText(node, sf)}(${params})${returns};`;
};

const signatureOfClass = (
	node: ts.ClassDeclaration,
	sf: ts.SourceFile,
): string => {
	const name = nameText(node.name, sf) || "default";
	const heritage = (node.heritageClauses ?? [])
		.map((clause) => collapse(clause.getText(sf)))
		.join(" ");
	return collapse(
		`export class ${name}${typeParamsText(node, sf)}${heritage === "" ? "" : ` ${heritage}`} { … }`,
	);
};

const dirOf = (path: string): string => {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
};

const joinPath = (dir: string, specifier: string): string => {
	const segments: string[] = [];
	for (const segment of `${dir}/${specifier}`.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.join("/");
};

/** Resolve a relative specifier to a file in the tree, or `null` for a bare one. */
const resolveModule = (
	fromPath: string,
	specifier: string,
	read: SourceReader,
): string | null => {
	if (!specifier.startsWith(".")) return null;
	const base = joinPath(dirOf(fromPath), specifier);
	for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
		if (read(candidate) !== null) return candidate;
	}
	return null;
};

const symbolFromExportDeclaration = (
	node: ts.ExportDeclaration,
	sf: ts.SourceFile,
): DocSymbol[] => {
	const specifier =
		node.moduleSpecifier === undefined
			? ""
			: ` from ${collapse(node.moduleSpecifier.getText(sf))}`;
	if (node.exportClause === undefined) return [];
	if (ts.isNamespaceExport(node.exportClause)) {
		const name = node.exportClause.name.text;
		return [
			{
				name,
				kind: "namespace",
				signature: `export * as ${name}${specifier};`,
				description: "",
				members: [],
			},
		];
	}
	const prefix = node.isTypeOnly ? "export type" : "export";
	return node.exportClause.elements.map((element) => ({
		name: element.name.text,
		kind: "re-export",
		signature: `${prefix} { ${element.name.text} }${specifier};`,
		description: "",
		members: [],
	}));
};

const collectModuleSymbols = (
	path: string,
	source: string,
	read: SourceReader,
	seen: ReadonlySet<string>,
): DocSymbol[] => {
	const sf = parse(path, source);
	const symbols: DocSymbol[] = [];
	const describe = (node: ts.Node): string => descriptionOf(source, node, sf);

	for (const statement of sf.statements) {
		if (ts.isVariableStatement(statement)) {
			if (!hasExportModifier(statement)) continue;
			for (const decl of statement.declarationList.declarations) {
				const name = nameText(decl.name, sf);
				if (name === "") continue;
				symbols.push({
					name,
					kind: variableKeyword(statement.declarationList.flags),
					signature: signatureOfVariable(
						variableKeyword(statement.declarationList.flags),
						decl,
						sf,
					),
					description: describe(statement),
					members: [],
				});
			}
			continue;
		}
		if (ts.isFunctionDeclaration(statement)) {
			if (!hasExportModifier(statement)) continue;
			const name = nameText(statement.name, sf) || "default";
			symbols.push({
				name,
				kind: "function",
				signature: signatureOfFunction(statement, sf),
				description: describe(statement),
				members: [],
			});
			continue;
		}
		if (ts.isClassDeclaration(statement)) {
			if (!hasExportModifier(statement)) continue;
			const name = nameText(statement.name, sf) || "default";
			symbols.push({
				name,
				kind: "class",
				signature: signatureOfClass(statement, sf),
				description: describe(statement),
				members: memberNames(statement.members, sf),
			});
			continue;
		}
		if (ts.isInterfaceDeclaration(statement)) {
			if (!hasExportModifier(statement)) continue;
			symbols.push({
				name: nameText(statement.name, sf),
				kind: "interface",
				signature: truncate(collapse(statement.getText(sf)), 1600),
				description: describe(statement),
				members: memberNames(statement.members, sf),
			});
			continue;
		}
		if (ts.isTypeAliasDeclaration(statement)) {
			if (!hasExportModifier(statement)) continue;
			const literal = ts.isTypeLiteralNode(statement.type)
				? memberNames(statement.type.members, sf)
				: [];
			symbols.push({
				name: nameText(statement.name, sf),
				kind: "type",
				signature: truncate(collapse(statement.getText(sf)), 1600),
				description: describe(statement),
				members: literal,
			});
			continue;
		}
		if (ts.isEnumDeclaration(statement)) {
			if (!hasExportModifier(statement)) continue;
			symbols.push({
				name: nameText(statement.name, sf),
				kind: "enum",
				signature: truncate(collapse(statement.getText(sf)), 600),
				description: describe(statement),
				members: memberNames(statement.members, sf),
			});
			continue;
		}
		if (ts.isModuleDeclaration(statement)) {
			if (!hasExportModifier(statement)) continue;
			symbols.push({
				name: nameText(statement.name, sf),
				kind: "namespace",
				signature: `export namespace ${nameText(statement.name, sf)} { … }`,
				description: describe(statement),
				members: [],
			});
			continue;
		}
		if (ts.isExportAssignment(statement)) {
			symbols.push({
				name: "default",
				kind: "default",
				signature: `export default ${truncate(collapse(statement.expression.getText(sf)), 140)};`,
				description: describe(statement),
				members: [],
			});
			continue;
		}
		if (ts.isExportDeclaration(statement)) {
			if (statement.exportClause === undefined) {
				// `export * from "./x"` — the symbols live in the target, so read it
				// and inline them; a bare specifier contributes nothing we can see.
				const specifier =
					statement.moduleSpecifier === undefined
						? null
						: statement.moduleSpecifier.getText(sf).replace(/["']/g, "");
				if (specifier === null) continue;
				const target = resolveModule(path, specifier, read);
				if (target === null || seen.has(target)) continue;
				const targetSource = read(target);
				if (targetSource === null) continue;
				symbols.push(
					...collectModuleSymbols(
						target,
						targetSource,
						read,
						new Set([...seen, target]),
					),
				);
				continue;
			}
			symbols.push(...symbolFromExportDeclaration(statement, sf));
		}
	}
	return symbols;
};

const dedupeByName = (symbols: readonly DocSymbol[]): DocSymbol[] => {
	const seen = new Set<string>();
	const unique: DocSymbol[] = [];
	for (const symbol of symbols) {
		if (seen.has(symbol.name)) continue;
		seen.add(symbol.name);
		unique.push(symbol);
	}
	return unique;
};

/** Every public export of one module, in declaration order. */
export const extractModuleSymbols = (
	path: string,
	source: string,
	read: SourceReader,
): DocSymbol[] =>
	dedupeByName(collectModuleSymbols(path, source, read, new Set([path])));

const findExportedVariable = (
	sf: ts.SourceFile,
	name: string,
): ts.VariableDeclaration | null => {
	for (const statement of sf.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if (!hasExportModifier(statement)) continue;
		for (const decl of statement.declarationList.declarations) {
			if (nameText(decl.name, sf) === name) return decl;
		}
	}
	return null;
};

/** Strip `as const`, `satisfies` and parentheses to reach the real expression. */
const unwrapExpression = (expression: ts.Expression): ts.Expression => {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current)
	) {
		current = current.expression;
	}
	return current;
};

/** The string values of an exported `as const` tuple, in declaration order. */
export const extractStringTuple = (source: string, name: string): string[] => {
	const sf = parse(name, source);
	const decl = findExportedVariable(sf, name);
	if (decl?.initializer === undefined) return [];
	const init = unwrapExpression(decl.initializer);
	if (!ts.isArrayLiteralExpression(init)) return [];
	return init.elements
		.filter(ts.isStringLiteralLike)
		.map((element) => element.text);
};

/** The value of an exported string constant, or `null`. */
export const extractStringConst = (
	source: string,
	name: string,
): string | null => {
	const sf = parse(name, source);
	const decl = findExportedVariable(sf, name);
	if (decl?.initializer === undefined) return null;
	const init = unwrapExpression(decl.initializer);
	return ts.isStringLiteralLike(init) ? init.text : null;
};

/**
 * The fields of an exported `z.object({ … })`, read from the AST: name, the zod
 * expression declaring it, whether it is required (no `.default`/`.catch`) and
 * its doc comment. The manifest page renders this table, so a later schema
 * change appears without anyone editing the page.
 */
export const extractZodObjectFields = (
	source: string,
	name: string,
): DocField[] => {
	const sf = parse(name, source);
	const decl = findExportedVariable(sf, name);
	if (decl?.initializer === undefined) return [];
	const init = unwrapExpression(decl.initializer);
	if (!ts.isCallExpression(init)) return [];
	const object = init.arguments.find(ts.isObjectLiteralExpression);
	if (object === undefined) return [];
	const fields: DocField[] = [];
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		const schema = collapse(property.initializer.getText(sf));
		fields.push({
			name: nameText(property.name, sf),
			schema,
			required: !/\.(default|catch)\(/.test(schema),
			description: descriptionOf(source, property, sf),
		});
	}
	return fields;
};
