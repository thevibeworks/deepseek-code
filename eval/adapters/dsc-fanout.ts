// Adapter: dsc with sub-agents ENABLED — the fan-out arm. Sub-agents are
// opt-in in the shipped CLI (BASELINE.md "dsc M4 sub-agents"), so this
// adapter is what exercises them. The `dsc` adapter is the default path.
// History note: rows tagged adapter "dsc-solo" (2026-08-05) were produced
// by the then-default-on build with sub-agents suppressed; they are
// directly comparable to today's plain `dsc`.
import type { Adapter } from "../run";
import dsc from "./dsc";

const adapter: Adapter = {
  name: "dsc-fanout",
  run(opts) {
    return dsc.run({ ...opts, env: { ...(opts.env ?? {}), DSC_SUBAGENTS: "1" } });
  },
};

export default adapter;
