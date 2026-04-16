import assert from "node:assert/strict";
import test from "node:test";
import {
    convertDateTimeLocalToOffsetIso,
    createDefaultScheduledDateTime,
} from "../public/js/helpers/datetime.js";
import {
    buildRecipientChoiceValue,
    parseRecipientChoiceValue,
    readRecipientDirectory,
    resolveScheduledMessageTarget,
} from "../public/js/helpers/recipient.js";
import { describeSession } from "../public/js/helpers/session.js";

test("convertDateTimeLocalToOffsetIso returns a timezone-aware ISO timestamp", () => {
    const iso = convertDateTimeLocalToOffsetIso("2026-04-15T18:30");
    const parsed = new Date(iso);

    assert.match(iso, /^2026-04-15T18:30:00[+-]\d{2}:\d{2}$/);
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth() + 1, 4);
    assert.equal(parsed.getDate(), 15);
    assert.equal(parsed.getHours(), 18);
    assert.equal(parsed.getMinutes(), 30);
});

test("createDefaultScheduledDateTime returns a datetime-local friendly value", () => {
    const value = createDefaultScheduledDateTime(new Date(2026, 3, 15, 18, 30, 40));
    assert.match(value, /^2026-04-15T18:35$/);
});

test("describeSession highlights QR pairing without blocking future scheduling", () => {
    const summary = describeSession({
        status: "qr",
        ready: false,
        authenticated: false,
        hasQrCode: true,
        qrCodeDataUrl: "data:image/png;base64,abc123",
        connectionState: "OPENING",
        loading: {
            percent: 42,
            message: "Booting",
        },
        lastEventAt: "2026-04-15T12:00:00.000Z",
    });

    assert.equal(summary.label, "Pairing required");
    assert.equal(summary.tone, "warning");
    assert.equal(summary.showQr, true);
    assert.match(summary.note, /still schedule future messages/i);
    assert.match(summary.connection, /42%/);
    assert.match(summary.lastEventLabel, /Last update:/);
});

test("readRecipientDirectory normalizes contacts and groups from one session payload", () => {
    const directory = readRecipientDirectory({
        chatDirectory: {
            contacts: [{
                targetValue: "5551999999999",
                label: "Alice",
                phoneNumber: "5551999999999",
            }],
            groups: [{
                targetValue: "120363043210123456@g.us",
                label: "Launch Team",
            }],
            refreshedAt: "2026-04-15T12:00:00.000Z",
        },
    });

    assert.deepEqual(directory, {
        contacts: [{
            targetType: "contact",
            targetValue: "5551999999999",
            label: "Alice",
            phoneNumber: "5551999999999",
        }],
        groups: [{
            targetType: "group",
            targetValue: "120363043210123456@g.us",
            label: "Launch Team",
            phoneNumber: null,
        }],
        refreshedAt: "2026-04-15T12:00:00.000Z",
    });
});

test("recipient helper encodes and resolves picker selections before manual phone numbers", () => {
    const selectionValue = buildRecipientChoiceValue({
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    });

    assert.equal(selectionValue, "group:120363043210123456@g.us");
    assert.deepEqual(parseRecipientChoiceValue(selectionValue), {
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    });
    assert.deepEqual(resolveScheduledMessageTarget({
        selectedRecipientValue: selectionValue,
        phoneNumber: "5551999999999",
    }), {
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    });
    assert.deepEqual(resolveScheduledMessageTarget({
        selectedRecipientValue: "",
        phoneNumber: " +55 (51) 99999-9999 ",
    }), {
        phoneNumber: "+55 (51) 99999-9999",
    });
});
