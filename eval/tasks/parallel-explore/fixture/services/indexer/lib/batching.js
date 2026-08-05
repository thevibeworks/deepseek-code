// Batching layer. HARD_BATCH_CAP protects the heap on the shared
// indexer boxes: whatever config asks for, we never exceed the cap.
const HARD_BATCH_CAP = 256;

function effectiveBatchSize(configured) {
  return Math.min(HARD_BATCH_CAP, configured);
}

module.exports = { effectiveBatchSize, HARD_BATCH_CAP };
