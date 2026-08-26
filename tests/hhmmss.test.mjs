import assert from "node:assert/strict";
import { test } from "node:test";
import { generateICS } from "../ics.js";

const periods = [
  { start: "08:00", end: "08:45" },
  { start: "08:55", end: "09:40" },
];

function baseCfg(over = {}) {
  return {
    calendarName: "测试课表",
    firstMonday: "2026-08-31",
    periods,
    courses: [{ name: "高数", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-2" }],
    alarmMinutes: 0,
    ...over,
  };
}

test("generateICS: 接受浏览器 time 控件的 HH:MM:SS", () => {
  const ics = generateICS(
    baseCfg({
      periods: [{ start: "08:00:00", end: "08:45:00" }],
      courses: [{ name: "早课", day: 1, startPeriod: 1, endPeriod: 1, weeks: "1" }],
    })
  );
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260831T080000/);
  assert.match(ics, /DTEND;TZID=Asia\/Shanghai:20260831T084500/);
});

test("generateICS: 带小数秒的 time 控件值也可解析", () => {
  const ics = generateICS(
    baseCfg({
      periods: [{ start: "08:00:00.000", end: "08:45:00.500" }],
      courses: [{ name: "早课", day: 1, startPeriod: 1, endPeriod: 1, weeks: "1" }],
    })
  );
  assert.match(ics, /20260831T080000/);
  assert.match(ics, /20260831T084500/);
});
