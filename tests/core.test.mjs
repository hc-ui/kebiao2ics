import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWeeks, parseYmd, addDays, mondayOf, generateICS, countEvents, findConflicts } from "../ics.js";

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

test("parseWeeks: 1至16 / 1到16", () => {
  assert.deepEqual(parseWeeks("1至16"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(parseWeeks("1到8"), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("parseWeeks: 全角破折号 1－16", () => {
  assert.deepEqual(parseWeeks("1－8"), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("parseWeeks: 全周/全部/每周/全程 视为 1-16", () => {
  assert.deepEqual(parseWeeks("全周"), parseWeeks("1-16"));
  assert.deepEqual(parseWeeks("全部"), parseWeeks("1-16"));
  assert.deepEqual(parseWeeks("每周"), parseWeeks("1-16"));
  assert.deepEqual(parseWeeks("全程"), parseWeeks("1-16"));
});

test("parseWeeks: 前8周", () => {
  assert.deepEqual(parseWeeks("前8周"), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("parseWeeks: 非法输入抛错", () => {
  assert.throws(() => parseWeeks(""), /周数不能为空/);
  assert.throws(() => parseWeeks("abc"), /无法分类|无法识别/);
  assert.throws(() => parseWeeks("5-2"), /颠倒/);
  assert.throws(() => parseWeeks("1-99"), /超出/);
});
