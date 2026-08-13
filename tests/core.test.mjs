import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWeeks, addDays, mondayOf, generateICS, countEvents, findConflicts } from "../ics.js";

// ---------------------------------------------------------------------------
// parseWeeks
// ---------------------------------------------------------------------------

test("parseWeeks: 连续范围", () => {
  assert.deepEqual(parseWeeks("1-4"), [1, 2, 3, 4]);
});

test("parseWeeks: 多段范围（跳过某周）", () => {
  assert.deepEqual(parseWeeks("1-3,5-6"), [1, 2, 3, 5, 6]);
});

test("parseWeeks: 单周", () => {
  assert.deepEqual(parseWeeks("1-8单"), [1, 3, 5, 7]);
});

test("parseWeeks: 双周（含'双周'后缀）", () => {
  assert.deepEqual(parseWeeks("2-16双周"), [2, 4, 6, 8, 10, 12, 14, 16]);
});

test("parseWeeks: 容忍'第…周'、空格、中文逗号、顿号", () => {
  assert.deepEqual(parseWeeks("第1-2周， 4、6"), [1, 2, 4, 6]);
});

test("parseWeeks: 单独一周", () => {
  assert.deepEqual(parseWeeks("9"), [9]);
});

test("parseWeeks: 去重排序", () => {
  assert.deepEqual(parseWeeks("3,1-4"), [1, 2, 3, 4]);
});

test("parseWeeks: 全角波浪线/长横线也可作范围符", () => {
  assert.deepEqual(parseWeeks("1~3"), [1, 2, 3]);
});

test("parseWeeks: 非法输入抛错", () => {
  assert.throws(() => parseWeeks(""), /周数不能为空/);
  assert.throws(() => parseWeeks("abc"), /无法识别/);
  assert.throws(() => parseWeeks("5-2"), /颠倒/);
  assert.throws(() => parseWeeks("1-99"), /超出/);
});

test("parseWeeks: 单周区间内无匹配周时报错", () => {
  assert.throws(() => parseWeeks("2-2单"), /为空/);
});

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------

test("addDays: 跨月", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
});

test("addDays: 跨年", () => {
  assert.equal(addDays("2026-12-29", 7), "2027-01-05");
});

test("mondayOf: 周一返回自身", () => {
  assert.equal(mondayOf("2026-08-31"), "2026-08-31"); // 周一
});

test("mondayOf: 周三对齐到周一", () => {
  assert.equal(mondayOf("2026-09-02"), "2026-08-31");
});

test("mondayOf: 周日属于本周（对齐到前面的周一）", () => {
  assert.equal(mondayOf("2026-09-06"), "2026-08-31");
});

// ---------------------------------------------------------------------------
// generateICS
// ---------------------------------------------------------------------------

const PERIODS = [
  { start: "08:00", end: "08:45" },
  { start: "08:55", end: "09:40" },
  { start: "10:00", end: "10:45" },
  { start: "10:55", end: "11:40" },
];

function baseCfg(overrides = {}) {
  return {
    calendarName: "测试课表",
    firstMonday: "2026-08-31",
    periods: PERIODS,
    courses: [
      {
        name: "高等数学",
        location: "教1-101",
        teacher: "张伟",
        day: 1,
        startPeriod: 1,
        endPeriod: 2,
        weeks: "1-2",
      },
    ],
    alarmMinutes: 15,
    ...overrides,
  };
}

test("generateICS: 基本结构", () => {
  const ics = generateICS(baseCfg());
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
  assert.match(ics, /TZID:Asia\/Shanghai/);
});

test("generateICS: 事件时间正确（第1周周一第1-2节）", () => {
  const ics = generateICS(baseCfg());
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260831T080000/);
  assert.match(ics, /DTEND;TZID=Asia\/Shanghai:20260831T094000/);
  // 第 2 周周一
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260907T080000/);
});

test("generateICS: 事件数量 = 周数之和", () => {
  const ics = generateICS(
    baseCfg({
      courses: [
        { name: "A", day: 1, startPeriod: 1, endPeriod: 1, weeks: "1-4" },
        { name: "B", day: 3, startPeriod: 2, endPeriod: 3, weeks: "1-4双" },
      ],
      alarmMinutes: 0,
    })
  );
  const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(count, 4 + 2);
});

test("generateICS: 周日课程日期正确（第1周周日 = 2026-09-06）", () => {
  const ics = generateICS(
    baseCfg({
      courses: [{ name: "选修", day: 7, startPeriod: 1, endPeriod: 1, weeks: "1" }],
    })
  );
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260906T080000/);
});

test("generateICS: 非周一的开学日期自动对齐到周一", () => {
  const ics = generateICS(baseCfg({ firstMonday: "2026-09-02" }));
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20260831T080000/);
});

test("generateICS: 文本转义（逗号、分号）", () => {
  const ics = generateICS(
    baseCfg({
      courses: [
        {
          name: "微积分,下;实验",
          location: "A;B,C",
          day: 1,
          startPeriod: 1,
          endPeriod: 1,
          weeks: "1",
        },
      ],
    })
  );
  assert.match(ics, /SUMMARY:微积分\\,下\\;实验/);
  assert.match(ics, /LOCATION:A\\;B\\,C/);
});

test("generateICS: 行折叠后每行不超过 75 字节", () => {
  const ics = generateICS(
    baseCfg({
      courses: [
        {
          name: "这是一门课程名称特别长的课程用来测试行折叠功能是否符合规范要求的课程",
          location: "某个非常非常非常长的教学楼名称的第九百九十九教室",
          teacher: "一位名字很长很长的老师",
          day: 1,
          startPeriod: 1,
          endPeriod: 1,
          weeks: "1",
        },
      ],
    })
  );
  const enc = new TextEncoder();
  for (const line of ics.split("\r\n")) {
    assert.ok(enc.encode(line).length <= 75, `行超长: ${line}`);
  }
});

test("generateICS: 提醒开关", () => {
  const withAlarm = generateICS(baseCfg({ alarmMinutes: 20 }));
  assert.match(withAlarm, /TRIGGER:-PT20M/);
  const noAlarm = generateICS(baseCfg({ alarmMinutes: 0 }));
  assert.doesNotMatch(noAlarm, /BEGIN:VALARM/);
});

test("generateICS: UID 稳定且唯一", () => {
  const ics = generateICS(baseCfg());
  const uids = [...ics.matchAll(/UID:(\S+)/g)].map((m) => m[1]);
  assert.equal(new Set(uids).size, uids.length);
  const again = generateICS(baseCfg());
  const uids2 = [...again.matchAll(/UID:(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(uids, uids2);
});

test("generateICS: 同名同时段的重复课程 UID 仍唯一", () => {
  const dup = { name: "高数", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-4" };
  const ics = generateICS(baseCfg({ courses: [dup, { ...dup }] }));
  const uids = [...ics.matchAll(/UID:(\S+)/g)].map((m) => m[1]);
  assert.equal(uids.length, 8);
  assert.equal(new Set(uids).size, 8);
});

test("generateICS: UID 不随课程列表顺序变化（重新导入可覆盖）", () => {
  const a = { name: "A课", day: 1, startPeriod: 1, endPeriod: 1, weeks: "1-2" };
  const b = { name: "B课", day: 2, startPeriod: 2, endPeriod: 3, weeks: "1" };
  const uidsOf = (courses) =>
    [...generateICS(baseCfg({ courses })).matchAll(/UID:(\S+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(uidsOf([a, b]), uidsOf([b, a]));
});

test("generateICS: 作息时间填错时报错指明节次", () => {
  const badPeriods = [
    { start: "08:00", end: "08:45" },
    { start: "", end: "09:40" },
  ];
  assert.throws(
    () =>
      generateICS(
        baseCfg({
          periods: badPeriods,
          courses: [{ name: "X", day: 1, startPeriod: 2, endPeriod: 2, weeks: "1" }],
        })
      ),
    /第 2 节的开始时间/
  );
});

test("generateICS: 下课时间早于上课时间时报错", () => {
  const reversed = [{ start: "10:00", end: "08:00" }];
  assert.throws(
    () =>
      generateICS(
        baseCfg({
          periods: reversed,
          courses: [{ name: "Y", day: 1, startPeriod: 1, endPeriod: 1, weeks: "1" }],
        })
      ),
    /下课时间不晚于上课时间/
  );
});

test("generateICS: 错误提示友好", () => {
  assert.throws(() => generateICS(baseCfg({ courses: [] })), /请先添加课程/);
  assert.throws(
    () =>
      generateICS(
        baseCfg({ courses: [{ name: "越界", day: 1, startPeriod: 1, endPeriod: 9, weeks: "1" }] })
      ),
    /节次超出/
  );
  assert.throws(
    () =>
      generateICS(
        baseCfg({ courses: [{ name: "", day: 1, startPeriod: 1, endPeriod: 1, weeks: "1" }] })
      ),
    /缺少名称/
  );
});

// ---------------------------------------------------------------------------
// countEvents
// ---------------------------------------------------------------------------

test("countEvents: 正常统计并忽略未填完整的课程", () => {
  assert.equal(
    countEvents([
      { weeks: "1-4" },
      { weeks: "1-4双" },
      { weeks: "" }, // 未填完 → 记 0
    ]),
    4 + 2
  );
});

// ---------------------------------------------------------------------------
// findConflicts
// ---------------------------------------------------------------------------

test("findConflicts: 同天同节次同周 → 冲突", () => {
  const conflicts = findConflicts([
    { name: "A", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-16" },
    { name: "B", day: 1, startPeriod: 2, endPeriod: 3, weeks: "8-10" },
  ]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].weeks, [8, 9, 10]);
});

test("findConflicts: 单双周互补 → 不冲突", () => {
  const conflicts = findConflicts([
    { name: "A", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-16单" },
    { name: "B", day: 1, startPeriod: 1, endPeriod: 2, weeks: "2-16双" },
  ]);
  assert.equal(conflicts.length, 0);
});

test("findConflicts: 不同天或节次不重叠 → 不冲突", () => {
  const conflicts = findConflicts([
    { name: "A", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-16" },
    { name: "B", day: 2, startPeriod: 1, endPeriod: 2, weeks: "1-16" },
    { name: "C", day: 1, startPeriod: 3, endPeriod: 4, weeks: "1-16" },
  ]);
  assert.equal(conflicts.length, 0);
});

test("findConflicts: 周数未填的课程跳过", () => {
  const conflicts = findConflicts([
    { name: "A", day: 1, startPeriod: 1, endPeriod: 2, weeks: "" },
    { name: "B", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-16" },
  ]);
  assert.equal(conflicts.length, 0);
});
