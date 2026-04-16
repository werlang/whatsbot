import assert from "node:assert/strict";
import test from "node:test";
import {
    convertDateTimeLocalToOffsetIso,
    createDefaultScheduledDateTime,
    formatDateTimeForDisplay,
    formatIsoForDisplay,
} from "../public/js/helpers/datetime.js";
import {
    buildRecipientChoiceValue,
    parseRecipientChoiceValue,
    readRecipientDirectory,
    resolveScheduledMessageTarget,
} from "../public/js/helpers/recipient.js";
import {
    buildScheduledMessageDraft,
    buildScheduledMessageViewModel,
    createScheduleFormMode,
    removeScheduledMessageFromCollection,
    sortScheduledMessages,
    upsertScheduledMessageInCollection,
} from "../public/js/helpers/scheduled-message.js";
import { describeSession, formatSessionTimestamp } from "../public/js/helpers/session.js";

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

test("display helpers force a 24-hour clock", () => {
    assert.match(formatDateTimeForDisplay("2026-04-15T18:30:00", "en-US"), /18:30/);
    assert.match(formatIsoForDisplay("2026-04-15T18:30:00", "en-US"), /18:30/);
    assert.match(formatSessionTimestamp("2026-04-15T18:30:00", "en-US"), /18:30/);
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
    assert.equal(summary.phase, "awaiting-qr");
    assert.equal(summary.tone, "warning");
    assert.equal(summary.showQr, true);
    assert.match(summary.note, /still schedule future messages/i);
    assert.match(summary.connection, /42%/);
    assert.match(summary.lastEventLabel, /Last update:/);
});

test("describeSession exposes one connecting phase after the QR scan is accepted", () => {
    const summary = describeSession({
        status: "authenticating",
        ready: false,
        authenticated: true,
        hasQrCode: false,
        connectionState: "CONNECTED",
        loading: {
            percent: 87,
            message: "Opening chats",
        },
    });

    assert.equal(summary.phase, "connecting");
    assert.equal(summary.label, "Authenticating");
    assert.match(summary.note, /still connecting/i);
    assert.match(summary.connection, /87%/);
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

test("scheduled-message helper builds one form draft from an editable schedule", () => {
    const draft = buildScheduledMessageDraft({
        id: "msg-1",
        targetType: "contact",
        targetValue: "5551999999999",
        phoneNumber: "5551999999999",
        message: "hello world",
        scheduledFor: "2026-04-15T18:30:00.000Z",
    });

    assert.equal(draft.id, "msg-1");
    assert.equal(draft.recipientValue, buildRecipientChoiceValue({
        targetType: "contact",
        targetValue: "5551999999999",
    }));
    assert.equal(draft.phoneNumber, "5551999999999");
    assert.equal(draft.message, "hello world");
    assert.match(draft.scheduledFor, /^2026-04-15T/);
});

test("scheduled-message helper derives render details and action availability", () => {
    const recipientLabelByValue = new Map([[
        buildRecipientChoiceValue({
            targetType: "group",
            targetValue: "120363043210123456@g.us",
        }),
        "Launch Team · Group",
    ]]);
    const viewModel = buildScheduledMessageViewModel({
        id: "msg-2",
        targetType: "group",
        targetValue: "120363043210123456@g.us",
        phoneNumber: null,
        message: "hello everyone",
        scheduledFor: "2026-04-15T18:30:00.000Z",
        status: "failed",
    }, recipientLabelByValue);

    assert.equal(viewModel.recipientLabel, "Launch Team · Group");
    assert.equal(viewModel.statusLabel, "Failed");
    assert.equal(viewModel.statusTone, "danger");
    assert.equal(viewModel.canEdit, true);
    assert.equal(viewModel.canDelete, true);
    assert.match(viewModel.scheduledForLabel, /18:30/);
});

test("scheduled-message helper switches form labels for edit mode", () => {
    assert.deepEqual(createScheduleFormMode(), {
        kicker: "New",
        title: "Message",
        submitLabel: "Schedule",
        cancelLabel: "Cancel edit",
        isEditing: false,
    });
    assert.deepEqual(createScheduleFormMode({ id: "msg-3" }), {
        kicker: "Editing",
        title: "Message",
        submitLabel: "Save changes",
        cancelLabel: "Cancel edit",
        isEditing: true,
    });
});

test("scheduled-message helper upserts, sorts, and removes collection entries", () => {
    const first = {
        id: "msg-1",
        scheduledFor: "2026-04-15T18:30:00.000Z",
    };
    const second = {
        id: "msg-2",
        scheduledFor: "2026-04-15T17:30:00.000Z",
    };
    const third = {
        id: "msg-3",
        scheduledFor: "2026-04-15T19:30:00.000Z",
    };

    const ordered = sortScheduledMessages([first, third, second]);
    assert.deepEqual(ordered.map(item => item.id), ["msg-2", "msg-1", "msg-3"]);

    const updated = upsertScheduledMessageInCollection(ordered, {
        id: "msg-1",
        scheduledFor: "2026-04-15T20:30:00.000Z",
    });
    assert.deepEqual(updated.map(item => item.id), ["msg-2", "msg-3", "msg-1"]);

    const remaining = removeScheduledMessageFromCollection(updated, "msg-3");
    assert.deepEqual(remaining.map(item => item.id), ["msg-2", "msg-1"]);
});
