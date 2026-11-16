import assert from "node:assert/strict";
import test from "node:test";
import {
    buildScheduledMessageEditGuard,
    buildScheduledMessageViewModel,
} from "../public/js/helpers/scheduled-message.js";

const sentRow = {
    id: "msg-sent",
    targetType: "contact",
    targetValue: "5551999999999",
    phoneNumber: "5551999999999",
    message: "already delivered",
    scheduledFor: "2026-04-15T18:30:00.000Z",
    status: "sent",
};

test("sent rows expose the sent-reason text and no actions", () => {
    const viewModel = buildScheduledMessageViewModel(sentRow);

    assert.equal(viewModel.status, "sent");
    assert.equal(viewModel.sentReason, "Sent — cannot edit a delivered message.");
    assert.equal(viewModel.canEdit, false);
    assert.equal(viewModel.canDelete, false);
});

test("edit guard blocks submission for a sent row and allows pending rows", () => {
    assert.deepEqual(buildScheduledMessageEditGuard(sentRow), {
        allowed: false,
        reason: "Sent — cannot edit a delivered message.",
    });
    assert.deepEqual(buildScheduledMessageEditGuard({ ...sentRow, status: "pending" }), {
        allowed: true,
        reason: "",
    });
    assert.deepEqual(buildScheduledMessageEditGuard({ ...sentRow, status: "failed" }), {
        allowed: true,
        reason: "",
    });
});
