import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../helpers/error.js";
import { normalizeRecipientName, resolveRecipientTarget } from "../helpers/recipient.js";

const directoryFixture = {
    contacts: [
        {
            id: "5551991111111@c.us",
            name: "Álvaro",
            targetType: "contact",
            targetValue: "5551991111111",
            phoneNumber: "5551991111111",
            chatId: "5551991111111@c.us",
            label: "Álvaro",
        },
        {
            id: "555195171104@c.us",
            name: "Vinicius",
            targetType: "contact",
            targetValue: "555195171104",
            phoneNumber: "555195171104",
            chatId: "555195171104@c.us",
            label: "Vinicius",
        },
        {
            id: "555391565003@c.us",
            name: "Vinícius Alves Hax",
            targetType: "contact",
            targetValue: "555391565003",
            phoneNumber: "555391565003",
            chatId: "555391565003@c.us",
            label: "Vinícius Alves Hax",
        },
    ],
    groups: [
        {
            id: "120363043210123456@g.us",
            name: "Águias",
            targetType: "group",
            targetValue: "120363043210123456@g.us",
            phoneNumber: null,
            chatId: "120363043210123456@g.us",
            label: "Águias",
        },
        {
            id: "120363043210123457@g.us",
            name: "Zulu equipe",
            targetType: "group",
            targetValue: "120363043210123457@g.us",
            phoneNumber: null,
            chatId: "120363043210123457@g.us",
            label: "Zulu equipe",
        },
    ],
    refreshedAt: "2026-11-15T12:00:00.000Z",
};

test("recipient resolves one case and diacritic insensitive name match", () => {
    assert.equal(normalizeRecipientName("  vINÍCIUS ALVES  "), "vinicius alves");
    assert.deepEqual(
        resolveRecipientTarget("  vINÍCIUS ALVES  ", directoryFixture),
        {
            targetType: "contact",
            targetValue: "555391565003@c.us",
        },
    );
    assert.deepEqual(
        resolveRecipientTarget("aguias", directoryFixture),
        {
            targetType: "group",
            targetValue: "120363043210123456@g.us",
        },
    );
    assert.deepEqual(
        resolveRecipientTarget("alvaro", directoryFixture, { targetType: "contact" }),
        {
            targetType: "contact",
            targetValue: "5551991111111@c.us",
        },
    );
});

test("recipient never prefers an exact name over other matching candidates", () => {
    assert.throws(
        () => resolveRecipientTarget("Vinicius", directoryFixture),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.data, null);
            assert.equal(
                error.message,
                'Multiple recipients found for "Vinicius": Vinicius (555195171104); Vinícius Alves Hax (555391565003). Use phoneNumber or targetValue to choose.',
            );
            assert.doesNotMatch(error.message, /@c\.us|@lid/);
            return true;
        },
    );

    assert.throws(
        () => resolveRecipientTarget("Vinicius", directoryFixture, { targetType: "group" }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.match(error.message, /^Multiple recipients found for "Vinicius":/);
            return true;
        },
    );

    const sharedNameDirectory = {
        contacts: [{ id: "5551999999999@c.us", name: "Projeto Alpha" }],
        groups: [{ id: "120363043210123456@g.us", name: "Projeto Alpha" }],
    };
    assert.throws(
        () => resolveRecipientTarget("Projeto Alpha", sharedNameDirectory),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(
                error.message,
                'Multiple recipients found for "Projeto Alpha": Projeto Alpha (120363043210123456@g.us); Projeto Alpha (5551999999999). Use phoneNumber or targetValue to choose.',
            );
            return true;
        },
    );
});

test("recipient reports a missing name without guessing", () => {
    assert.throws(
        () => resolveRecipientTarget("  Ninguém  ", directoryFixture),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.data, null);
            assert.equal(error.message, 'No recipient found for "Ninguém".');
            return true;
        },
    );

    assert.throws(
        () => resolveRecipientTarget("Vinicius", { contacts: [], groups: [], refreshedAt: null }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, 'No recipient found for "Vinicius".');
            return true;
        },
    );
});

test("recipient rejects invalid names and conflicting explicit addresses", () => {
    for (const invalidQuery of ["", "   ", null, undefined, 123, {}, []]) {
        assert.throws(
            () => resolveRecipientTarget(invalidQuery, directoryFixture),
            error => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 400);
                assert.equal(error.message, "recipient must be a non-empty name string.");
                return true;
            },
        );
    }

    assert.throws(
        () => resolveRecipientTarget("Vinícius Alves", directoryFixture, { targetType: "group" }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, "targetType does not match the resolved recipient.");
            return true;
        },
    );

    assert.throws(
        () => resolveRecipientTarget("aguias", directoryFixture, { targetType: "contact" }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, "targetType does not match the resolved recipient.");
            return true;
        },
    );
});

test("recipient counts distinct ids rather than duplicate directory rows", () => {
    const duplicateDirectory = {
        contacts: [
            {
                id: "555391565003@c.us",
                name: "Vinícius Alves Hax",
                targetType: "contact",
                targetValue: "555391565003",
                phoneNumber: "555391565003",
                chatId: "555391565003@c.us",
                label: "Vinícius Alves Hax",
            },
            {
                id: "555391565003@c.us",
                name: "Vinícius Alves Hax",
                targetType: "contact",
                targetValue: "555391565003",
                phoneNumber: "555391565003",
                chatId: "555391565003@c.us",
                label: "Vinícius Alves Hax",
            },
        ],
        groups: [
            {
                id: "120363043210123456@g.us",
                name: "Águias",
            },
            {
                id: "120363043210123456@g.us",
                name: "Águias",
            },
        ],
    };

    assert.deepEqual(resolveRecipientTarget("Vinicius Alves", duplicateDirectory), {
        targetType: "contact",
        targetValue: "555391565003@c.us",
    });
    assert.deepEqual(resolveRecipientTarget("aguias", duplicateDirectory), {
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    });
});
