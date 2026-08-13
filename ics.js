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
  const cleaned = pattern.replace(/[第周\s]/g, "").replace(/[，、;；]/g, ",");
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

/**
 * 生成 .ics 文件内容。
 *
 * @param {object} cfg
 * @param {string} cfg.calendarName  日历名称
 * @param {string} cfg.firstMonday   第一周周一，"YYYY-MM-DD"（非周一会自动对齐到所在周周一）
 * @param {Array<{start:string,end:string}>} cfg.periods  作息时间表，第 i 项为第 i+1 节
 * @param {Array<{name:string,location?:string,teacher?:string,day:number,startPeriod:number,endPeriod:number,weeks:string|number[]}>} cfg.courses
 * @param {number} [cfg.alarmMinutes=0]  提前提醒分钟数，0 表示不提醒
 * @returns {string} ics 文本
 */
export function generateICS(cfg) {
  const { calendarName = "我的课表", periods, courses, alarmMinutes = 0 } = cfg;
  if (!cfg.firstMonday) throw new Error("请先设置第一周周一的日期");
  if (!Array.isArray(periods) || !periods.length) throw new Error("作息时间表为空");
  if (!Array.isArray(courses) || !courses.length) throw new Error("请先添加课程");
  const firstMonday = mondayOf(cfg.firstMonday);

  const events = [];
  courses.forEach((c, idx) => {
    if (!c.name || !String(c.name).trim()) throw new Error(`第 ${idx + 1} 门课程缺少名称`);
    const day = Number(c.day);
    if (!(day >= 1 && day <= 7)) throw new Error(`课程「${c.name}」的星期无效`);
    const sp = Number(c.startPeriod);
    const ep = Number(c.endPeriod);
    if (!(sp >= 1 && ep >= sp && ep <= periods.length)) {
      throw new Error(`课程「${c.name}」的节次超出作息表范围（共 ${periods.length} 节）`);
    }
    const weeks = Array.isArray(c.weeks) ? c.weeks : parseWeeks(String(c.weeks));
    const startT = toIcsTime(periods[sp - 1].start);
    const endT = toIcsTime(periods[ep - 1].end);
    for (const w of weeks) {
      const date = addDays(firstMonday, (w - 1) * 7 + (day - 1));
      const dt = date.replace(/-/g, "");
      const descParts = [];
      if (c.teacher && String(c.teacher).trim()) descParts.push(`教师：${c.teacher}`);
      const periodLabel = sp === ep ? `第${sp}节` : `第${sp}-${ep}节`;
      descParts.push(`第${w}周 星期${DAY_CN[day]} ${periodLabel}`);
      events.push({
        uid: `kb2ics-c${idx}-d${day}-p${sp}-w${w}@kebiao2ics`,
        start: `${dt}T${startT}`,
        end: `${dt}T${endT}`,
        summary: c.name,
        location: c.location || "",
        description: descParts.join("\n"),
      });
    }
  });
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
