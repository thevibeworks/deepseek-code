// Digest scheduler. Users' notifications are coalesced into digest
// windows; the window length is environment-dependent — see windows.js
// for the resolution order.
const { coalescingWindowMinutes } = require("./windows");

function scheduleDigest(userId, pending) {
  const windowMin = coalescingWindowMinutes(process.env.NOTIFIER_ENV || "production");
  return { userId, sendAt: Date.now() + windowMin * 60_000, count: pending.length };
}

module.exports = { scheduleDigest };
