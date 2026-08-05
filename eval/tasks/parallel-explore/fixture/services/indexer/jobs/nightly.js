// Nightly full reindex. The batch size is whatever the batching layer
// decides — config.yml expresses a WISH, lib/batching.js has the final
// word (memory-safety cap).
const { effectiveBatchSize } = require("../lib/batching");
const CONFIGURED = require("../lib/configload").load(); // reads config.yml

async function run() {
  const batchSize = effectiveBatchSize(CONFIGURED.reindex.batchSize);
  // ... iterate index shards in `batchSize` chunks
  return batchSize;
}

module.exports = { run };
