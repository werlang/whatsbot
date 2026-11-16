import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicJsRoot = fileURLToPath(new URL("../public/js/", import.meta.url));
const nativeDialogPattern = /(?:\b(?:globalThis|window|self)\s*\.\s*)?\b(?:alert|confirm|prompt)\s*\(/;

/**
 * Lists every JavaScript file under the browser entry tree.
 *
 * @param {string} directory Root directory.
 * @returns {string[]} Absolute file paths.
 */
function listJavaScriptFiles(directory) {
    const files = [];

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listJavaScriptFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(entryPath);
        }
    }

    return files;
}

test("browser JavaScript never calls native alert, confirm or prompt", () => {
    const offenders = [];

    for (const filePath of listJavaScriptFiles(publicJsRoot)) {
        const contents = fs.readFileSync(filePath, "utf8");
        const relativePath = path.relative(publicJsRoot, filePath).split(path.sep).join("/");

        if (nativeDialogPattern.test(contents)) {
            offenders.push(relativePath);
        }
    }

    assert.deepEqual(offenders, []);
});

test("delegated row actions never gate on HTMLElement only", () => {
    // Clicking the icon lands on an SVGSVGElement/SVGUseElement, which is an Element but not an
    // HTMLElement: an HTMLElement-only guard silently drops the click (the owner's "edit does not
    // work"). The guard must accept any Element.
    const offenders = [];

    for (const file of listJavaScriptFiles(publicJsRoot)) {
        const source = fs.readFileSync(file, "utf8");

        if (/event\.target\s+instanceof\s+HTMLElement/.test(source)) {
            offenders.push(path.relative(publicJsRoot, file));
        }
    }

    assert.deepEqual(offenders, [], `delegated handlers must use instanceof Element: ${offenders.join(", ")}`);
});
