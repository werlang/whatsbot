import assert from "node:assert/strict";
import test from "node:test";
import {
    buildContactInitials,
    buildContactSearchResults,
    foldContactSearchText,
} from "../public/js/helpers/contact-directory.js";

/**
 * Builds one normalized directory fixture.
 *
 * @returns {{ contacts: object[], groups: object[] }} Directory fixture.
 */
function createDirectory() {
    return {
        contacts: [
            { targetType: "contact", targetValue: "5551991111111", label: "Álvaro", phoneNumber: "5551991111111" },
            { targetType: "contact", targetValue: "555195171104", label: "Vinícius Guimarães", phoneNumber: "555195171104" },
            { targetType: "contact", targetValue: "5511888888888", label: "Zulu", phoneNumber: "5511888888888" },
        ],
        groups: [
            { targetType: "group", targetValue: "120363043210123456@g.us", label: "Águias", phoneNumber: null },
            { targetType: "group", targetValue: "120363043210123457@g.us", label: "Equipe 2026", phoneNumber: null },
        ],
    };
}

test("contact search folds accents and matches names or phone and JID digits", () => {
    const directory = createDirectory();

    assert.equal(foldContactSearchText("  Vinícius  "), "vinicius");
    assert.deepEqual(
        buildContactSearchResults(directory, "alvaro").contacts.map(entry => entry.label),
        ["Álvaro"],
    );
    assert.deepEqual(
        buildContactSearchResults(directory, "vinicius").contacts.map(entry => entry.label),
        ["Vinícius Guimarães"],
    );
    assert.deepEqual(
        buildContactSearchResults(directory, "5551951").contacts.map(entry => entry.label),
        ["Vinícius Guimarães"],
    );
    assert.deepEqual(
        buildContactSearchResults(directory, "120363043210123457").groups.map(entry => entry.label),
        ["Equipe 2026"],
    );
    assert.equal(buildContactSearchResults(directory, "").totalMatches, 5);
});

test("contact search sorts sections by pt-BR name and caps the combined result", () => {
    const contacts = Array.from({ length: 100 }, (_value, index) => ({
        targetType: "contact",
        targetValue: String(5551000000000 + index),
        label: index === 0 ? "Zuleica" : `Contato ${String(index).padStart(3, "0")}`,
        phoneNumber: String(5551000000000 + index),
    }));
    const directory = {
        contacts,
        groups: [
            { targetType: "group", targetValue: "120363043210123456@g.us", label: "Águias", phoneNumber: null },
        ],
    };

    const result = buildContactSearchResults(directory, "");

    assert.equal(result.renderedCount, 60);
    assert.equal(result.totalMatches, 101);
    assert.equal(result.contacts.length + result.groups.length, 60);
    assert.equal(result.summary, "Showing 60 of 101 — refine your search");
    assert.deepEqual(
        result.contacts.slice(0, 3).map(entry => entry.label),
        ["Contato 001", "Contato 002", "Contato 003"],
    );
    assert.deepEqual(result.groups.map(entry => entry.label), ["Águias"]);
    assert.equal(result.contacts.some(entry => entry.label === "Zuleica"), false);
});

test("contact initials use the first and last name words", () => {
    assert.equal(buildContactInitials("Vinícius Alves Hax"), "VH");
    assert.equal(buildContactInitials("Águias"), "Á");
    assert.equal(buildContactInitials("  "), "?");
});
