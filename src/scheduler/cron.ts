// Five-field cron (minute hour day-of-month month day-of-week), vixie
// semantics. ONE parser: `dsc job add` validates with it and the serve
// daemon fires with it (Round 3 delta #6 — a schedule that parses at add
// time but not at fire time is how jobs silently never run).
//
// Firing is match-based, not next()-based: the daemon asks "does this
// minute match" and remembers the last fired minute. next() exists for
// `dsc ps` display only.

export type CronField = { any: boolean; values: Set<number> };

export type CronSchedule = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

const BOUNDS: [name: string, min: number, max: number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7], // 0 and 7 are both Sunday
];

/** Parse a cron expression or throw with a message a user can act on. */
export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron needs 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expr}"`,
    );
  }
  const parsed = fields.map((f, i) => parseField(f, ...BOUNDS[i]));
  // Normalize Sunday: 7 -> 0, so matching only ever checks 0-6.
  const dow = parsed[4];
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  return { minute: parsed[0], hour: parsed[1], dom: parsed[2], month: parsed[3], dow: parsed[4] };
}

function parseField(field: string, name: string, min: number, max: number): CronField {
  if (field === "*") return { any: true, values: new Set() };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") throw new Error(`empty element in ${name} field "${field}"`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`too many "/" in ${name} element "${part}"`);
    const step = stepPart === undefined ? 1 : parseNum(stepPart, `${name} step`);
    if (step < 1) throw new Error(`${name} step must be >= 1 in "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (more !== undefined || a === "" || b === "") {
        throw new Error(`bad range "${rangePart}" in ${name} field`);
      }
      lo = parseNum(a, name);
      hi = parseNum(b, name);
      if (lo > hi) throw new Error(`range ${lo}-${hi} is reversed in ${name} field`);
    } else {
      if (stepPart !== undefined) {
        throw new Error(`a step needs a range: use "${rangePart}-${max}/${step}" or "*/${step}" in ${name} field`);
      }
      lo = hi = parseNum(rangePart, name);
    }
    if (lo < min || hi > max) {
      throw new Error(`${name} value out of range ${min}-${max} in "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any: false, values };
}

function parseNum(s: string, what: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number in ${what}`);
  return Number(s);
}

/** Does this schedule match the given minute? Vixie rule: when BOTH
 * day-of-month and day-of-week are restricted, either matching fires. */
export function cronMatches(s: CronSchedule, d: Date): boolean {
  const inField = (f: CronField, v: number): boolean => f.any || f.values.has(v);
  if (!inField(s.minute, d.getMinutes())) return false;
  if (!inField(s.hour, d.getHours())) return false;
  if (!inField(s.month, d.getMonth() + 1)) return false;
  const domOk = inField(s.dom, d.getDate());
  const dowOk = inField(s.dow, d.getDay());
  if (!s.dom.any && !s.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** Next matching minute strictly after `from`. For display (`dsc ps`);
 * the daemon fires on cronMatches, never on this. Scans minute by minute
 * with a 5-year guard — an expression that cannot fire inside 5 years
 * (e.g. Feb 30) returns null rather than looping forever. */
export function cronNext(s: CronSchedule, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 5 * 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(s, d)) return d;
  }
  return null;
}
