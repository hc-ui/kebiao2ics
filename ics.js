/**
 * kebiao2ics 核心逻辑：周数表达式解析 + iCalendar (.ics) 文件生成。
 * 纯函数、无依赖，浏览器与 Node.js 通用（供单元测试）。
 */

const TZID = "Asia/Shanghai";
const DAY_CN = ["", "一", "二", "三", "四", "五", "六", "日"];

/**
 * 解析周数表达式，返回升序去重的周数数组。
 *
 * 支持写法（可混用，逗号/顿号/分号分隔）：
 *   "1-16"          第 1 到 16 周
 *   "1-8,10-16"     跳过第 9 周
 *   "2-16双"        双周（也接受"双周"后缀）
 *   "1-15单"        单周
 *   "3,5,9"         单独几周
 *   "第1-16周"      容忍"第/周"字样与空格
 */
export function parseWeeks(pattern, maxWeek = 30) {
  if (typeof pattern !== "string" || !pattern.trim()) {
    throw new Error("周数不能为空，例如：1-16");
  }
  const raw = pattern.trim();
  if (/^(全周|全部|每周|全程)$/.test(raw)) {
    return Array.from({ length: 16 }, (_, i) => i + 1);
  }
  const front = raw.match(/^前\s*(\d+)\s*周?$/);
  if (front) {
    const n = parseInt(front[1], 10);
    if (n < 1 || n > maxWeek) {
      throw new Error(`周数超出 1-${maxWeek} 范围：「${raw}」`);
    }
    return Array.from({ length: n }, (_, i) => i + 1);
  }
  const cleaned = raw
    .replace(/[第周\s]/g, "")
    .replace(/[至到－]/g, "-")
    .replace(/[，、;；]/g, ",");
  const weeks = new Set();
  for (const seg of cleaned.split(",")) {
    if (!seg) continue;
    const m = seg.match(/^(\d+)(?:[-~—–](\d+))?(单|双)?$/);
    if (!m) {
      throw new Error(`无法识别的周数写法：「${seg}」，支持如 1-16、1-8,10-16、2-16双`);
    }
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    const parity = m[3];
    if (a < 1 || b > maxWeek || a > b) {
      throw new Error(`周数超出 1-${maxWeek} 范围或起止颠倒：「${seg}」`);
    }
    for (let w = a; w <= b; w++) {
      if (parity === "单" && w % 2 === 0) continue;
      if (parity === "双" && w % 2 === 1) continue;
      weeks.add(w);
    }
  }
  if (!weeks.size) throw new Error("周数解析结果为空，请检查单双周写法");
  return [...weeks].sort((x, y) => x - y);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 校验并规范化日历日期。拒绝缺位、非数字，以及 2026-02-30 这类会被 Date 悄悄滚月的值。
 * 手工备份 / 导入损坏 JSON 时，宁可报错也不生成 NaN 日程。
 */
export function parseYmd(ymd) {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd.trim())) {
    throw new Error(`日期格式应为 YYYY-MM-DD，收到：「${ymd ?? ""}」`);
  }
  const raw = ymd.trim();
  const [y, m, d] = raw.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new Error(`无效日期：「${raw}」`);
  }
  return raw;
}

/** "YYYY-MM-DD" 加 days 天，返回 "YYYY-MM-DD"（本地日期运算，无时区问题）。 */
export function addDays(ymd, days) {
  const raw = parseYmd(ymd);
  const [y, m, d] = raw.split("-").map(Number);
  const n = Number(days);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`天数必须是整数，收到：「${days}」`);
  }
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** 返回 ymd 所在周的周一（周日视为本周第 7 天）。 */
export function mondayOf(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay() === 0 ? 7 : dt.getDay();
  return addDays(ymd, 1 - dow);
}

/** RFC 5545 文本转义。 */
function icsEscape(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 行折叠：每行至多 75 字节，续行以空格开头。 */
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > 75) {
      out.push(cur);
      cur = " " + ch;
      curBytes = 1 + b;
    } else {
      cur += ch;
      curBytes += b;
    }
  }
  out.push(cur);
  return out.join("\r\n");
}

function toIcsTime(hhmm) {
  const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`时间格式应为 HH:MM，收到：「${hhmm}」`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`时间超出 00:00–23:59，收到：「${hhmm}」`);
  }
  return `${pad2(hour)}${pad2(minute)}00`;
}

/** 取第 idx 节（1 起）的开始/结束时间，出错时指明具体节次。 */
function periodTime(periods, idx, field) {
  try {
    return toIcsTime(periods[idx - 1][field]);
  } catch (e) {
    throw new Error(`作息时间表第 ${idx} 节的${field === "start" ? "开始" : "结束"}时间有误：${e.message}`);
  }
}

/** 稳定的短哈希（djb2），用于生成不随课程增删顺序变化的事件 UID。 */
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 两个 "YYYY-MM-DD" 之间的天数差（b - a）。 */
function diffDays(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}
