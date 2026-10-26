import { describe, expect, test } from "bun:test";
import { responses } from "@lib/providers/responses";
import type { SendCtx } from "@lib/providers/types";

/**
 * The Responses body's attachment items. The claim is the **wire shape**: its
 * two item kinds take different fields (`image_url` for an image,
 * `filename` + `file_data` for a file), and a body that writes one field name
 * for both is refused before the turn starts.
 */

const ctx = (parts: SendCtx["parts"]): SendCtx => ({
	msg: "look at this",
	prev: undefined,
	apiUrl: "https://api.openai.com/v1",
	apiKey: "fixture-openai-key-not-real",
	model: "gpt-5.2",
	fetchTool: false,
	parts,
});

const inputOf = (body: unknown): unknown[] =>
	(body as { input: unknown[] }).input;

describe("a Responses turn with attachments", () => {
	test("an image rides as input_image with image_url", () => {
		const body = responses.buildRequest(
			responses.template,
			ctx([
				{
					kind: "image",
					name: "shot.png",
					dataUrl: "data:image/png;base64,AAAA",
				},
			]),
		);
		const [item] = inputOf(body) as {
			content: Array<Record<string, unknown>>;
		}[];
		expect(item?.content).toEqual([
			{ type: "input_text", text: "look at this" },
			{
				type: "input_image",
				image_url: "data:image/png;base64,AAAA",
			},
		]);
	});

	test("a file rides as input_file with its name and data, never a file_url", () => {
		const body = responses.buildRequest(
			responses.template,
			ctx([
				{
					kind: "file",
					name: "notes.pdf",
					dataUrl: "data:application/pdf;base64,BBBB",
				},
			]),
		);
		const serialised = JSON.stringify(inputOf(body));
		expect(serialised).not.toContain("file_url");
		const [item] = inputOf(body) as {
			content: Array<Record<string, unknown>>;
		}[];
		expect(item?.content).toEqual([
			{ type: "input_text", text: "look at this" },
			{
				type: "input_file",
				filename: "notes.pdf",
				file_data: "data:application/pdf;base64,BBBB",
			},
		]);
	});

	test("a seeded conversation carries an attachment in the same shape a turn wrote", () => {
		const seeded = responses.seedHistory([
			{
				role: "user",
				text: "",
				parts: [
					{
						kind: "file",
						name: "notes.pdf",
						dataUrl: "data:application/pdf;base64,BBBB",
					},
				],
			},
		]);
		expect(JSON.stringify(seeded)).not.toContain("file_url");
		expect(JSON.stringify(seeded)).toContain('"file_data"');
	});
});
