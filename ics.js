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

/** "YYYY-MM-DD" 加 days 天，返回 "YYYY-MM-DD"（本地日期运算，无时区问题）。 */
export function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
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
  return `${pad2(m[1])}${m[2]}00`;
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

/**
 * 生成 .ics 文件内容。
 *
 * @param {object} cfg
 * @param {string} cfg.calendarName  日历名称
 * @param {string} cfg.firstMonday   第一周周一，"YYYY-MM-DD"（非周一会自动对齐到所在周周一）
 * @param {Array<{start:string,end:string}>} cfg.periods  作息时间表，第 i 项为第 i+1 节
 * @param {Array<{name:string,location?:string,teacher?:string,day:number,startPeriod:number,endPeriod:number,weeks:string|number[]}>} cfg.courses
 * @param {number} [cfg.alarmMinutes=0]  提前提醒分钟数，0 表示不提醒
 * @param {Array<{date:string,mode:"off"|"swap",sourceDay?:number}>} [cfg.adjustments=[]]
 *   节假日调休：mode="off" 当天停课；mode="swap" 当天改上 sourceDay（1-7）那天的课。
 * @returns {string} ics 文本
 */
export function generateICS(cfg) {
  const { calendarName = "我的课表", periods, courses, alarmMinutes = 0, adjustments = [] } = cfg;
  if (!cfg.firstMonday) throw new Error("请先设置第一周周一的日期");
  if (!Array.isArray(periods) || !periods.length) throw new Error("作息时间表为空");
  if (!Array.isArray(courses) || !courses.length) throw new Error("请先添加课程");
  const firstMonday = mondayOf(cfg.firstMonday);

  // 调休规则表：date → rule（同一天多条规则时，后写的生效）
  const ruleByDate = new Map();
  for (const r of adjustments) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) continue;
    if (r.mode === "swap") {
      const sd = Number(r.sourceDay);
      if (!(sd >= 1 && sd <= 7)) continue;
      ruleByDate.set(r.date, { mode: "swap", sourceDay: sd });
    } else if (r.mode === "off") {
      ruleByDate.set(r.date, { mode: "off" });
    }
  }

  // 第一遍：校验每门课并准备好时间等派生数据
  const prepared = courses.map((c, idx) => {
    if (!c.name || !String(c.name).trim()) throw new Error(`第 ${idx + 1} 门课程缺少名称`);
    const day = Number(c.day);
    if (!(day >= 1 && day <= 7)) throw new Error(`课程「${c.name}」的星期无效`);
    const sp = Number(c.startPeriod);
    const ep = Number(c.endPeriod);
    if (!(sp >= 1 && ep >= sp && ep <= periods.length)) {
      throw new Error(`课程「${c.name}」的节次超出作息表范围（共 ${periods.length} 节）`);
    }
    const weeks = Array.isArray(c.weeks) ? c.weeks : parseWeeks(String(c.weeks));
    const startT = periodTime(periods, sp, "start");
    const endT = periodTime(periods, ep, "end");
    if (endT <= startT) {
      throw new Error(
        `课程「${c.name}」的下课时间不晚于上课时间，请检查作息时间表第 ${sp} 节到第 ${ep} 节的时间设置`
      );
    }
    return {
      name: c.name,
      location: c.location || "",
      teacher: c.teacher && String(c.teacher).trim() ? String(c.teacher).trim() : "",
      day, sp, ep, weeks, startT, endT,
      periodLabel: sp === ep ? `第${sp}节` : `第${sp}-${ep}节`,
    };
  });

  const events = [];
  const seenUids = new Set();
  const pushEvent = (uidBase, ev) => {
    let uid = `${uidBase}@kebiao2ics`;
    for (let k = 2; seenUids.has(uid); k++) uid = `${uidBase}-${k}@kebiao2ics`;
    seenUids.add(uid);
    events.push({ ...ev, uid });
  };

  // 常规每周课程（被调休规则覆盖的日期跳过）
  for (const p of prepared) {
    for (const w of p.weeks) {
      const date = addDays(firstMonday, (w - 1) * 7 + (p.day - 1));
      if (ruleByDate.has(date)) continue;
      const dt = date.replace(/-/g, "");
      const descParts = [];
      if (p.teacher) descParts.push(`教师：${p.teacher}`);
      descParts.push(`第${w}周 星期${DAY_CN[p.day]} ${p.periodLabel}`);
      pushEvent(`kb2ics-${hashText(p.name)}-d${p.day}-p${p.sp}-${p.ep}-w${w}`, {
        start: `${dt}T${p.startT}`,
        end: `${dt}T${p.endT}`,
        summary: p.name,
        location: p.location,
        description: descParts.join("\n"),
      });
    }
  }

  // 调休：换课日按 sourceDay 的课表补课
  for (const [date, rule] of ruleByDate) {
    if (rule.mode !== "swap") continue;
    const dd = diffDays(firstMonday, date);
    if (dd < 0) continue;
    const w = Math.floor(dd / 7) + 1;
    const dt = date.replace(/-/g, "");
    for (const p of prepared) {
      if (p.day !== rule.sourceDay || !p.weeks.includes(w)) continue;
      const descParts = [];
      if (p.teacher) descParts.push(`教师：${p.teacher}`);
      descParts.push(`调休：本日按星期${DAY_CN[rule.sourceDay]}课表上课（第${w}周 ${p.periodLabel}）`);
      pushEvent(`kb2ics-${hashText(p.name)}-adj${dt}-p${p.sp}-${p.ep}`, {
        start: `${dt}T${p.startT}`,
        end: `${dt}T${p.endT}`,
        summary: p.name,
        location: p.location,
        description: descParts.join("\n"),
      });
    }
  }

  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const now = new Date();
  const dtstamp =
    now.getUTCFullYear() +
    pad2(now.getUTCMonth() + 1) +
    pad2(now.getUTCDate()) +
    "T" +
    pad2(now.getUTCHours()) +
    pad2(now.getUTCMinutes()) +
    pad2(now.getUTCSeconds()) +
    "Z";

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kebiao2ics//hc-ui.github.io/kebiao2ics//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
    `X-WR-TIMEZONE:${TZID}`,
    "BEGIN:VTIMEZONE",
    `TZID:${TZID}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=${TZID}:${ev.start}`,
      `DTEND;TZID=${TZID}:${ev.end}`,
      `SUMMARY:${icsEscape(ev.summary)}`
    );
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (alarmMinutes > 0) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsEscape(ev.summary)}`,
        `TRIGGER:-PT${Math.round(alarmMinutes)}M`,
        "END:VALARM"
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * 检测课程时间冲突：同一天、节次区间重叠、且上课周数有交集。
 * 返回 [{a, b, weeks}]，a/b 为课程在数组中的下标，weeks 为冲突的周数。
 * 周数无法解析的课程跳过（表单校验会另行提示）。
 */
export function findConflicts(courses) {
  const parsed = courses.map((c) => {
    try {
      return new Set(Array.isArray(c.weeks) ? c.weeks : parseWeeks(String(c.weeks)));
    } catch {
      return null;
    }
  });
  const conflicts = [];
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      const A = courses[i];
      const B = courses[j];
      if (Number(A.day) !== Number(B.day)) continue;
      if (Number(A.endPeriod) < Number(B.startPeriod) || Number(B.endPeriod) < Number(A.startPeriod)) continue;
      if (!parsed[i] || !parsed[j]) continue;
      const shared = [...parsed[j]].filter((w) => parsed[i].has(w)).sort((x, y) => x - y);
      if (shared.length) conflicts.push({ a: i, b: j, weeks: shared });
    }
  }
  return conflicts;
}

/** 统计将生成的事件数（供界面展示）。解析失败的课程计为 0。 */
export function countEvents(courses) {
  let n = 0;
  for (const c of courses) {
    try {
      n += (Array.isArray(c.weeks) ? c.weeks : parseWeeks(String(c.weeks))).length;
    } catch {
      /* 忽略未填完整的课程 */
    }
  }
  return n;
}
