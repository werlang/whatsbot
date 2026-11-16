import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../helpers/error.js";
import {
    CONTACT_TARGET_TYPE,
    GROUP_TARGET_TYPE,
    normalizeMessageTarget,
} from "../helpers/message-target.js";

test("normalizeMessageTarget accepts only supported address forms", () => {
    assert.deepEqual(normalizeMessageTarget({ phoneNumber: "555391565003" }), {
        targetType: CONTACT_TARGET_TYPE,
        targetValue: "555391565003",
        phoneNumber: "555391565003",
    });

    assert.deepEqual(normalizeMessageTarget({ targetValue: "555391565003@c.us" }), {
        targetType: CONTACT_TARGET_TYPE,
        targetValue: "555391565003",
        phoneNumber: "555391565003",
    });

    assert.deepEqual(normalizeMessageTarget({ targetValue: "  555391565003@C.US  " }), {
        targetType: CONTACT_TARGET_TYPE,
        targetValue: "555391565003",
        phoneNumber: "555391565003",
    });

    assert.deepEqual(normalizeMessageTarget({ targetValue: "120363043210123456@g.us" }), {
        targetType: GROUP_TARGET_TYPE,
        targetValue: "120363043210123456@g.us",
        phoneNumber: null,
    });

    assert.deepEqual(normalizeMessageTarget({ targetValue: "  123456789-123456@G.US  " }), {
        targetType: GROUP_TARGET_TYPE,
        targetValue: "123456789-123456@g.us",
        phoneNumber: null,
    });

    assert.deepEqual(normalizeMessageTarget({
        targetType: CONTACT_TARGET_TYPE,
        targetValue: "555391565003@c.us",
        phoneNumber: "5551999999999",
    }), {
        targetType: CONTACT_TARGET_TYPE,
        targetValue: "555391565003",
        phoneNumber: "555391565003",
    });
});

test("normalizeMessageTarget rejects unsafe coercions with status 400", () => {
    const unsafeContactInputs = [
        "38865310056602@lid",
        "abc555391565003",
        "555391565003@example.com",
        "+55 (53) 91565-003",
        "555391565003@c.us.evil",
        "",
        "   ",
    ];

    for (const value of unsafeContactInputs) {
        assert.throws(
            () => normalizeMessageTarget({ targetValue: value }),
            error => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 400);
                assert.equal(error.message, "targetValue must be digits or a valid WhatsApp contact chat id.");
                return true;
            },
        );
    }

    for (const value of ["x@g.us", "123@lid@g.us"]) {
        assert.throws(
            () => normalizeMessageTarget({ targetValue: value }),
            error => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 400);
                assert.equal(error.message, "targetValue must be a valid WhatsApp group chat id.");
                return true;
            },
        );
    }

    for (const value of ["123456789", "123456789@c.us", "1234567890123456", "1234567890123456@c.us"]) {
        assert.throws(
            () => normalizeMessageTarget({ targetValue: value }),
            error => {
                assert.ok(error instanceof HttpError);
                assert.equal(error.status, 400);
                assert.equal(error.message, "phoneNumber must contain between 10 and 15 digits.");
                return true;
            },
        );
    }
});

test("normalizeMessageTarget rejects target type and address mismatches", () => {
    assert.throws(
        () => normalizeMessageTarget({
            targetType: CONTACT_TARGET_TYPE,
            targetValue: "120363043210123456@g.us",
        }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, "targetValue must be digits or a valid WhatsApp contact chat id.");
            return true;
        },
    );

    assert.throws(
        () => normalizeMessageTarget({
            targetType: GROUP_TARGET_TYPE,
            targetValue: "555391565003@c.us",
        }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, "targetValue must be a valid WhatsApp group chat id.");
            return true;
        },
    );

    assert.throws(
        () => normalizeMessageTarget({
            targetType: GROUP_TARGET_TYPE,
            phoneNumber: "555391565003",
        }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, "targetValue must be a valid WhatsApp group chat id.");
            return true;
        },
    );

    assert.throws(
        () => normalizeMessageTarget({
            targetType: "channel",
            targetValue: "555391565003",
        }),
        error => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 400);
            assert.equal(error.message, "targetType must be either 'contact' or 'group'.");
            return true;
        },
    );
});
