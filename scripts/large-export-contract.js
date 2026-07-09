"use strict";

const assert = require("node:assert/strict");

const COMMAND_TYPES = new Set(["start", "cancel"]);
const EVENT_TYPES = new Set(["accepted", "progress", "log", "status", "complete", "error", "cancelled"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function assertPlainObject(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim(), `${label} must not be empty`);
}

function assertFiniteNumber(value, label) {
  assert.equal(typeof value, "number", `${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
}

function assertPercent(value, label) {
  assertFiniteNumber(value, label);
  assert.ok(value >= 0 && value <= 100, `${label} must be between 0 and 100`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createInitialState(snapshot = {}) {
  return {
    jobs: clone(snapshot.jobs || {}),
    logs: clone(snapshot.logs || []),
    checkpoints: clone(snapshot.checkpoints || {}),
    commands: clone(snapshot.commands || []),
    events: clone(snapshot.events || [])
  };
}

function persist(storage, state) {
  if (storage && typeof storage.set === "function") {
    storage.set(snapshotState(state));
  }
}

function snapshotState(state) {
  return {
    jobs: clone(state.jobs),
    logs: clone(state.logs),
    checkpoints: clone(state.checkpoints),
    commands: clone(state.commands),
    events: clone(state.events)
  };
}

function validateStartCommand(command) {
  assertPlainObject(command.payload, "start payload");
  assertNonEmptyString(command.payload.scope, "start payload.scope");
  assert.equal(command.payload.scope, "current", "start payload.scope must be current");
  assertNonEmptyString(command.payload.format, "start payload.format");
  assertPlainObject(command.payload.conversation, "start payload.conversation");
  assertNonEmptyString(command.payload.conversation.id, "start payload.conversation.id");
  assert.ok(Array.isArray(command.payload.conversation.messages), "start payload.conversation.messages must be an array");
  assert.ok(command.payload.conversation.messages.length > 0, "start payload.conversation.messages must not be empty");
}

function validateCommand(command) {
  assertPlainObject(command, "worker command");
  assertNonEmptyString(command.type, "worker command.type");
  assert.ok(COMMAND_TYPES.has(command.type), `Unsupported worker command type: ${command.type}`);
  assertNonEmptyString(command.jobId, "worker command.jobId");
  if (command.type === "start") validateStartCommand(command);
  if (command.type === "cancel" && command.reason != null) {
    assert.equal(typeof command.reason, "string", "cancel reason must be a string");
  }
}

function validateProgressEvent(event) {
  assertNonEmptyString(event.phase, "progress event.phase");
  assertPercent(event.percent, "progress event.percent");
  assertFiniteNumber(event.loaded, "progress event.loaded");
  assertFiniteNumber(event.total, "progress event.total");
  assert.ok(event.loaded >= 0, "progress event.loaded must be non-negative");
  assert.ok(event.total >= 0, "progress event.total must be non-negative");
  assert.ok(event.loaded <= event.total, "progress event.loaded must not exceed progress event.total");
}

function validateWorkerEvent(event) {
  assertPlainObject(event, "worker event");
  assertNonEmptyString(event.type, "worker event.type");
  assert.ok(EVENT_TYPES.has(event.type), `Unsupported worker event type: ${event.type}`);
  assertNonEmptyString(event.jobId, "worker event.jobId");
  if (event.type === "progress") validateProgressEvent(event);
  if (event.type === "log") {
    assertNonEmptyString(event.level, "log event.level");
    assertNonEmptyString(event.message, "log event.message");
  }
  if (event.type === "status") {
    assertNonEmptyString(event.status, "status event.status");
    assert.ok(
      ["queued", "running", "paused", "completed", "failed", "cancelled"].includes(event.status),
      "status event.status must be a known status"
    );
  }
  if (event.type === "complete") {
    assertPlainObject(event.result, "complete event.result");
    assertNonEmptyString(event.result.filename, "complete event.result.filename");
  }
  if (event.type === "error") {
    assertNonEmptyString(event.message, "error event.message");
  }
}

function createLargeExportContractHarness(options = {}) {
  const storage = options.storage || null;
  const state = createInitialState(options.snapshot || storage?.get?.() || {});

  function postCommand(command) {
    validateCommand(command);
    if (command.type === "start") {
      state.jobs[command.jobId] = {
        jobId: command.jobId,
        scope: command.payload.scope,
        format: command.payload.format,
        status: "queued",
        cancelled: false,
        percent: 0,
        loaded: 0,
        total: command.payload.conversation.messages.length,
        conversationTotal: 1,
        updatedAt: command.createdAt || "1970-01-01T00:00:00.000Z"
      };
    }
    if (command.type === "cancel") {
      const job = state.jobs[command.jobId];
      assert.ok(job, "cancel command must target a known job");
      job.cancelled = true;
      job.status = "cancelled";
      job.cancelReason = command.reason || "";
      state.logs.unshift({
        jobId: command.jobId,
        level: "info",
        message: "Cancellation requested",
        at: command.createdAt || "1970-01-01T00:00:00.000Z"
      });
    }
    state.commands.push(clone(command));
    persist(storage, state);
  }

  function receiveEvent(event) {
    validateWorkerEvent(event);
    const job = state.jobs[event.jobId];
    assert.ok(job, "worker event must target a known job");
    assert.ok(!TERMINAL_STATUSES.has(job.status) || event.type === "log", "terminal jobs must ignore non-log events");

    if (event.type === "progress") {
      assert.ok(event.percent >= job.percent, "progress percent must be monotonic");
      job.status = "running";
      job.percent = event.percent;
      job.loaded = event.loaded;
      job.total = event.total;
      job.phase = event.phase;
      state.checkpoints[event.jobId] = {
        jobId: event.jobId,
        status: job.status,
        percent: job.percent,
        loaded: job.loaded,
        total: job.total,
        phase: job.phase
      };
    }
    if (event.type === "status") {
      job.status = event.status;
      state.checkpoints[event.jobId] = {
        ...(state.checkpoints[event.jobId] || { jobId: event.jobId }),
        status: event.status,
        message: event.message || ""
      };
    }
    if (event.type === "log") {
      state.logs.unshift({
        jobId: event.jobId,
        level: event.level,
        message: event.message,
        at: event.at || "1970-01-01T00:00:00.000Z",
        details: event.details || {}
      });
      state.logs = state.logs.slice(0, 50);
    }
    if (event.type === "complete") {
      job.status = "completed";
      job.percent = 100;
      job.result = clone(event.result);
      state.checkpoints[event.jobId] = {
        jobId: event.jobId,
        status: "completed",
        percent: 100,
        result: clone(event.result)
      };
    }
    if (event.type === "error") {
      job.status = "failed";
      job.error = event.message;
      state.checkpoints[event.jobId] = {
        jobId: event.jobId,
        status: "failed",
        message: event.message,
        category: event.category || ""
      };
    }
    if (event.type === "cancelled") {
      job.status = "cancelled";
      job.cancelled = true;
      state.checkpoints[event.jobId] = {
        jobId: event.jobId,
        status: "cancelled",
        message: event.message || ""
      };
    }

    state.events.push(clone(event));
    persist(storage, state);
  }

  return {
    postCommand,
    receiveEvent,
    snapshot: () => snapshotState(state),
    state
  };
}

module.exports = {
  createLargeExportContractHarness,
  validateCommand,
  validateWorkerEvent
};
