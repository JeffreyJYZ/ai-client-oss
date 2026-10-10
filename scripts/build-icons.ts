#!/usr/bin/env bun
/**
 * Rasterize the favicon mark (`web/public/favicon.svg`) into every raster
 * icon the browser and the OS need.
 *
 *   bun scripts/build-icons.ts
 *
 * `resvg` (brew install resvg) does the rasterizing. It keeps the alpha
 * channel, so the rounded square's corners stay transparent — `qlmanage`
 * was used once and flattened the mark onto white, which is why the tab
 * icon showed white corners.
 *
 * The `.ico` is assembled here because no installed tool writes a
 * PNG-embedded ICO without another dependency: the container is a small
 * header plus one 16-byte entry per image.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SVG = join(ROOT, "web/public/favicon.svg");
const OUT = join(ROOT, "web/public");

/** Rasterizer binary; override with `RESVG_BIN`. */
const RESVG = process.env.RESVG_BIN ?? "resvg";

const PNG_OUTPUTS: readonly (readonly [number, string])[] = [
	[32, "favicon-32.png"],
	[256, "favicon-256.png"],
	[180, "apple-touch-icon.png"],
];

/** Sizes embedded in `favicon.ico`, smallest first. */
const ICO_SIZES: readonly number[] = [16, 32, 48];

/** Render the SVG to a square PNG at `size` pixels. */
const rasterize = (size: number, out: string): void => {
	execFileSync(RESVG, ["--width", `${size}`, "--height", `${size}`, SVG, out]);
};

/** One ICONDIRENTRY (16 bytes) plus the PNG it points at. */
const icoEntry = (size: number, png: Buffer, offset: number): Buffer => {
	const entry = Buffer.alloc(16);
	// 0 means 256 in this format; our sizes are all below it.
	entry.writeUInt8(size, 0);
	entry.writeUInt8(size, 1);
	entry.writeUInt16LE(1, 4); // planes
	entry.writeUInt16LE(32, 6); // bits per pixel
	entry.writeUInt32LE(png.length, 8);
	entry.writeUInt32LE(offset, 12);
	return entry;
};

const buildIco = (
	images: readonly { readonly size: number; readonly png: Buffer }[],
): Buffer => {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(1, 2); // resource type: icon
	header.writeUInt16LE(images.length, 4);

	let offset = header.length + images.length * 16;
	const entries = images.map(({ size, png }) => {
		const entry = icoEntry(size, png, offset);
		offset += png.length;
		return entry;
	});

	return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
};

const scratch = mkdtempSync(join(tmpdir(), "ai-client-icons-"));

try {
	for (const [size, name] of PNG_OUTPUTS) {
		rasterize(size, join(OUT, name));
		console.log(`${name}  ${size}x${size}`);
	}

	const images = ICO_SIZES.map((size) => {
		const path = join(scratch, `${size}.png`);
		rasterize(size, path);
		return { size, png: readFileSync(path) };
	});
	const ico = join(OUT, "favicon.ico");
	writeFileSync(ico, buildIco(images));
	console.log(`favicon.ico  ${ICO_SIZES.join(", ")}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
