import { describe, expect, test } from "bun:test";
import { healDsml } from "../src/provider/dsml";

const FW = "｜"; // U+FF5C fullwidth pipe

describe("DSML healing", () => {
  test("plain text passes through untouched", () => {
    const r = healDsml("just some text");
    expect(r.text).toBe("just some text");
    expect(r.calls).toEqual([]);
  });

  test("fullwidth-pipe envelope heals into a tool call", () => {
    const t =
      `before\n<${FW}DSML${FW}tool_calls>\n` +
      `<${FW}DSML${FW}invoke name="get_weather">\n` +
      `<${FW}DSML${FW}parameter name="location" string="true">San Francisco, CA</${FW}DSML${FW}parameter>\n` +
      `</${FW}DSML${FW}invoke>\n` +
      `</${FW}DSML${FW}tool_calls>\nafter`;
    const r = healDsml(t);
    expect(r.text).toBe("before\n\nafter");
    expect(r.calls).toEqual([
      { name: "get_weather", input: { location: "San Francisco, CA" } },
    ]);
  });

  test("ASCII-pipe variant heals too", () => {
    const t =
      '<|DSML|tool_calls><|DSML|invoke name="read">' +
      '<|DSML|parameter name="path">a.js</|DSML|parameter>' +
      '<|DSML|parameter name="offset" string="false">15</|DSML|parameter>' +
      "</|DSML|invoke></|DSML|tool_calls>";
    const r = healDsml(t);
    expect(r.text).toBe("");
    expect(r.calls).toEqual([{ name: "read", input: { path: "a.js", offset: 15 } }]);
  });

  test("multiple invokes in one wrapper", () => {
    const t =
      '<|DSML|tool_calls><|DSML|invoke name="a"></|DSML|invoke>' +
      '<|DSML|invoke name="b"></|DSML|invoke></|DSML|tool_calls>';
    const r = healDsml(t);
    expect(r.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });
});
