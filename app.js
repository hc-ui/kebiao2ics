import { parseWeeks, mondayOf, generateICS, countEvents, findConflicts } from "./ics.js";

const STORE_KEY = "kebiao2ics-v1";
const DAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const PALETTE = [
  ["#eef2ff", "#4338ca"],
  ["#ecfdf5", "#047857"],
  ["#fff7ed", "#c2410c"],
  ["#fdf2f8", "#be185d"],
  ["#f0f9ff", "#0369a1"],
  ["#fefce8", "#a16207"],
  ["#f5f3ff", "#6d28d9"],
  ["#fef2f2", "#b91c1c"],
];

const PRESETS = {
  std45: [
    ["08:00", "08:45"], ["08:55", "09:40"], ["10:00", "10:45"], ["10:55", "11:40"],
    ["14:00", "14:45"], ["14:55", "15:40"], ["16:00", "16:45"], ["16:55", "17:40"],
    ["19:00", "19:45"], ["19:55", "20:40"], ["20:50", "21:35"], ["21:45", "22:30"],
  ],
  std50: [
    ["08:30", "09:20"], ["09:30", "10:20"], ["10:40", "11:30"], ["11:40", "12:30"],
    ["14:00", "14:50"], ["15:00", "15:50"], ["16:10", "17:00"], ["17:10", "18:00"],
    ["19:00", "19:50"], ["20:00", "20:50"], ["21:00", "21:50"], ["21:55", "22:45"],
  ],
};

const SAMPLE_COURSES = [
  { name: "高等数学A", location: "教1-101", teacher: "张伟", day: 1, startPeriod: 1, endPeriod: 2, weeks: "1-16" },
  { name: "大学英语", location: "外语楼204", teacher: "李华", day: 1, startPeriod: 3, endPeriod: 4, weeks: "1-16" },
  { name: "数据结构", location: "计算机楼305", teacher: "王芳", day: 2, startPeriod: 3, endPeriod: 4, weeks: "1-8,10-16" },
  { name: "体育（篮球）", location: "东操场", teacher: "刘强", day: 3, startPeriod: 5, endPeriod: 6, weeks: "1-16" },
  { name: "数据结构实验", location: "实验楼B203", teacher: "王芳", day: 4, startPeriod: 7, endPeriod: 8, weeks: "2-16双" },
  { name: "线性代数", location: "教2-203", teacher: "陈明", day: 5, startPeriod: 1, endPeriod: 2, weeks: "1-15单" },
  { name: "形势与政策", location: "大礼堂", teacher: "", day: 5, startPeriod: 7, endPeriod: 8, weeks: "9-12" },
];

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

function defaultFirstMonday() {
  const now = new Date();
  const y = now.getFullYear();
  const anchor = now.getMonth() >= 5 ? `${y}-09-01` : `${y}-03-01`;
  return mondayOf(anchor);
}

function defaultState() {
  const now = new Date();
  const season = now.getMonth() >= 5 ? "秋" : "春";
  return {
    semester: {
      firstMonday: defaultFirstMonday(),
      calName: `${now.getFullYear()}${season}课表`,
      alarm: 15,
    },
    periods: PRESETS.std45.map(([start, end]) => ({ start, end })),
    courses: [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    if (!s.semester || !Array.isArray(s.periods) || !Array.isArray(s.courses)) return defaultState();
    return s;
  } catch {
    return defaultState();
  }
}

let state = loadState();
let editIndex = -1;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式或存储被禁用时，数据仅在本次会话内有效，不影响生成功能 */
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function courseColor(i) {
  return PALETTE[i % PALETTE.length];
}

// ---------------------------------------------------------------------------
// 学期设置
// ---------------------------------------------------------------------------

function renderSemester() {
  $("firstMonday").value = state.semester.firstMonday;
  $("calName").value = state.semester.calName;
  $("alarm").value = String(state.semester.alarm);
}

$("firstMonday").addEventListener("change", () => {
  const v = $("firstMonday").value;
  if (!v) return;
  const snapped = mondayOf(v);
  state.semester.firstMonday = snapped;
  $("firstMonday").value = snapped;
  save();
  refreshOutputs();
});
$("calName").addEventListener("input", () => {
  state.semester.calName = $("calName").value;
  save();
});
$("alarm").addEventListener("change", () => {
  state.semester.alarm = Number($("alarm").value);
  save();
});

// ---------------------------------------------------------------------------
// 作息时间表
// ---------------------------------------------------------------------------

function renderPeriods() {
  const box = $("periodsList");
  box.innerHTML = state.periods
    .map(
      (p, i) => `
      <div class="period-row" data-i="${i}">
        <b>第${i + 1}节</b>
        <input type="time" class="pstart" value="${esc(p.start)}">
        <span>–</span>
        <input type="time" class="pend" value="${esc(p.end)}">
      </div>`
    )
    .join("");
  box.querySelectorAll(".period-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector(".pstart").addEventListener("change", (e) => {
      state.periods[i].start = e.target.value;
      save();
      refreshOutputs();
    });
    row.querySelector(".pend").addEventListener("change", (e) => {
      state.periods[i].end = e.target.value;
      save();
      refreshOutputs();
    });
  });
  fillPeriodSelects();
}

$("addPeriod").addEventListener("click", () => {
  const last = state.periods[state.periods.length - 1];
  const toMin = (t) => {
    const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const toHHMM = (min) => {
    const v = ((min % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  };
  let start = "08:00";
  let end = "08:45";
  const ls = last ? toMin(last.start) : null;
  const le = last ? toMin(last.end) : null;
  if (ls !== null && le !== null && le > ls) {
    // 课间默认 10 分钟，时长沿用上一节
    start = toHHMM(le + 10);
    end = toHHMM(le + 10 + (le - ls));
  } else if (le !== null) {
    start = toHHMM(le + 10);
    end = toHHMM(le + 55);
  }
  state.periods.push({ start, end });
  save();
  renderPeriods();
});
$("delPeriod").addEventListener("click", () => {
  if (state.periods.length <= 1) return;
  const n = state.periods.length;
  if (state.courses.some((c) => c.endPeriod >= n)) {
    alert(`有课程用到第 ${n} 节，先修改那门课的节次再删。`);
    return;
  }
  state.periods.pop();
  save();
  renderPeriods();
});
document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.periods = PRESETS[btn.dataset.preset].map(([start, end]) => ({ start, end }));
    save();
    renderPeriods();
    refreshOutputs();
  });
});

// ---------------------------------------------------------------------------
// 课程表单
// ---------------------------------------------------------------------------

function fillDaySelect() {
  $("cDay").innerHTML = DAY_NAMES.slice(1)
    .map((d, i) => `<option value="${i + 1}">${d}</option>`)
    .join("");
}

function fillPeriodSelects() {
  const n = state.periods.length;
  const opts = (sel) => {
    const cur = Number(sel.value) || 1;
    sel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">第${i + 1}节</option>`).join("");
    sel.value = String(Math.min(cur, n));
  };
  opts($("cStart"));
  opts($("cEnd"));
}

$("cWeeks").addEventListener("input", () => {
  const hint = $("weeksHint");
  const v = $("cWeeks").value.trim();
  if (!v) {
    hint.textContent = "支持：1-16 · 1-8,10-16 · 2-16双 · 1-15单";
    hint.style.color = "";
    return;
  }
  try {
    const weeks = parseWeeks(v);
    hint.textContent = `共 ${weeks.length} 周（第 ${weeks[0]}–${weeks[weeks.length - 1]} 周）`;
    hint.style.color = "var(--ok)";
  } catch (e) {
    hint.textContent = e.message;
    hint.style.color = "var(--danger)";
  }
});

$("courseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("cName").value.trim();
  const weeksStr = $("cWeeks").value.trim();
  if (!name || !weeksStr) return;
  try {
    parseWeeks(weeksStr);
  } catch (err) {
    alert(err.message);
    return;
  }
  let sp = Number($("cStart").value);
  let ep = Number($("cEnd").value);
  if (ep < sp) [sp, ep] = [ep, sp];
  const course = {
    name,
    location: $("cLoc").value.trim(),
    teacher: $("cTeacher").value.trim(),
    day: Number($("cDay").value),
    startPeriod: sp,
    endPeriod: ep,
    weeks: weeksStr,
  };
  if (editIndex >= 0) {
    state.courses[editIndex] = course;
  } else {
    state.courses.push(course);
  }
  exitEditMode();
  save();
  renderCourses();
  refreshOutputs();
});

function enterEditMode(i) {
  editIndex = i;
  const c = state.courses[i];
  $("cName").value = c.name;
  $("cLoc").value = c.location || "";
  $("cTeacher").value = c.teacher || "";
  $("cDay").value = String(c.day);
  $("cStart").value = String(c.startPeriod);
  $("cEnd").value = String(c.endPeriod);
  $("cWeeks").value = c.weeks;
  $("cWeeks").dispatchEvent(new Event("input"));
  $("courseSubmit").textContent = "保存修改";
  $("courseCancel").hidden = false;
  renderCourses();
  $("cName").focus();
}

function exitEditMode() {
  editIndex = -1;
  $("courseForm").reset();
  $("cWeeks").dispatchEvent(new Event("input"));
  $("courseSubmit").textContent = "添加课程";
  $("courseCancel").hidden = true;
}

$("courseCancel").addEventListener("click", () => {
  exitEditMode();
  renderCourses();
});

$("loadSample").addEventListener("click", () => {
  if (state.courses.length && !confirm("载入示例会追加 7 门示例课程，继续？")) return;
  state.courses.push(...SAMPLE_COURSES.map((c) => ({ ...c })));
  save();
  renderCourses();
  refreshOutputs();
});

$("clearAll").addEventListener("click", () => {
  if (!state.courses.length) return;
  if (!confirm("确定清空全部课程？（学期设置和作息表保留）")) return;
  state.courses = [];
  exitEditMode();
  save();
  renderCourses();
  refreshOutputs();
});

// ---------------------------------------------------------------------------
// 课程列表
// ---------------------------------------------------------------------------

function renderCourses() {
  const ul = $("courseList");
  const view = state.courses
    .map((c, i) => ({ c, i }))
    .sort((x, y) => x.c.day - y.c.day || x.c.startPeriod - y.c.startPeriod);
  ul.innerHTML = view
    .map(({ c, i }) => {
      const [, deep] = courseColor(i);
      let weeksLabel = `第${c.weeks}周`;
      try {
        const w = parseWeeks(c.weeks);
        weeksLabel = `第${c.weeks}周 · 共${w.length}次`;
      } catch { /* 显示原文 */ }
      return `
      <li class="course-item${i === editIndex ? " editing" : ""}" style="--cc:${deep}">
        <span class="cname">${esc(c.name)}</span>
        <span class="cmeta">${DAY_NAMES[c.day]} ${c.startPeriod === c.endPeriod ? `第${c.startPeriod}节` : `第${c.startPeriod}-${c.endPeriod}节`} · ${esc(weeksLabel)}${c.location ? " · " + esc(c.location) : ""}${c.teacher ? " · " + esc(c.teacher) : ""}</span>
        <span class="ops">
          <button type="button" class="mini" data-edit="${i}">编辑</button>
          <button type="button" class="mini danger" data-del="${i}">删除</button>
        </span>
      </li>`;
    })
    .join("");
  ul.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => enterEditMode(Number(b.dataset.edit))));
  ul.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      state.courses.splice(Number(b.dataset.del), 1);
      if (editIndex >= 0) exitEditMode();
      save();
      renderCourses();
      refreshOutputs();
    })
  );
}

// ---------------------------------------------------------------------------
// 课表预览
// ---------------------------------------------------------------------------

function renderPreview() {
  const box = $("preview");
  const empty = $("previewEmpty");
  if (!state.courses.length) {
    box.hidden = true;
    empty.hidden = false;
    $("parityNote").hidden = true;
    return;
  }
  empty.hidden = true;
  box.hidden = false;

  const hasWeekend = state.courses.some((c) => c.day >= 6);
  const days = hasWeekend ? 7 : 5;
  const maxP = Math.max(4, ...state.courses.map((c) => c.endPeriod));

  box.style.gridTemplateColumns = `52px repeat(${days}, minmax(84px, 1fr))`;
  box.style.gridTemplateRows = `30px repeat(${maxP}, 46px)`;

  const cells = [];
  for (let d = 1; d <= days; d++) {
    cells.push(`<div class="pv-head" style="grid-column:${d + 1};grid-row:1">${DAY_NAMES[d]}</div>`);
  }
  for (let p = 1; p <= maxP; p++) {
    const t = state.periods[p - 1];
    cells.push(
      `<div class="pv-time" style="grid-column:1;grid-row:${p + 1}"><b>${p}</b>${t ? `<span>${esc(t.start)}</span>` : ""}</div>`
    );
  }

  // 同一格子（同天同节次区间）的课程合并显示（如单双周交替的两门课）
  const groups = new Map();
  state.courses.forEach((c, i) => {
    if (c.day > days) return;
    const key = `${c.day}-${c.startPeriod}-${c.endPeriod}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, idx: i });
  });
  let hasParity = false;
  for (const list of groups.values()) {
    const first = list[0];
    const [bg, deep] = courseColor(first.idx);
    const inner = list
      .map((c) => {
        const parity = /单/.test(c.weeks) ? "（单周）" : /双/.test(c.weeks) ? "（双周）" : "";
        if (parity) hasParity = true;
        return `<span class="n">${esc(c.name)}${parity}</span>${c.location ? `<span class="l">${esc(c.location)}</span>` : ""}`;
      })
      .join("");
    cells.push(
      `<div class="pv-block" style="grid-column:${first.day + 1};grid-row:${first.startPeriod + 1} / ${first.endPeriod + 2};background:${bg};color:${deep}">${inner}</div>`
    );
  }
  box.innerHTML = cells.join("");
  $("parityNote").hidden = !hasParity;
}

// ---------------------------------------------------------------------------
// 统计与生成
// ---------------------------------------------------------------------------

function renderStats() {
  const el = $("stats");
  if (!state.courses.length) {
    el.innerHTML = "还没有课程。添加课程或点上方「载入示例课表」试试。";
    return;
  }
  const events = countEvents(state.courses);
  let minW = Infinity, maxW = 0;
  for (const c of state.courses) {
    try {
      const w = parseWeeks(c.weeks);
      minW = Math.min(minW, w[0]);
      maxW = Math.max(maxW, w[w.length - 1]);
    } catch { /* 忽略 */ }
  }
  const range = maxW ? `覆盖第 <b>${minW}–${maxW}</b> 周` : "";
  let html = `共 <b>${state.courses.length}</b> 门课 · 将生成 <b>${events}</b> 个日历日程 · ${range}`;

  const conflicts = findConflicts(state.courses);
  if (conflicts.length) {
    const items = conflicts.slice(0, 3).map(({ a, b, weeks }) => {
      const A = state.courses[a];
      const B = state.courses[b];
      const wLabel = weeks.length > 4 ? `${weeks.slice(0, 4).join("、")} 等 ${weeks.length} 周` : `${weeks.join("、")} 周`;
      return `「${esc(A.name)}」和「${esc(B.name)}」在${DAY_NAMES[A.day]}第 ${wLabel}时间重叠`;
    });
    const more = conflicts.length > 3 ? `，另有 ${conflicts.length - 3} 处` : "";
    html += `<span class="conflict-warn">注意：${items.join("；")}${more}，请核对星期 / 节次 / 周数。</span>`;
  }
  el.innerHTML = html;
}

function refreshOutputs() {
  renderPreview();
  renderStats();
}

$("generate").addEventListener("click", () => {
  const err = $("genError");
  err.hidden = true;
  try {
    const ics = generateICS({
      calendarName: state.semester.calName || "我的课表",
      firstMonday: state.semester.firstMonday,
      periods: state.periods,
      courses: state.courses,
      alarmMinutes: state.semester.alarm,
    });
    const safeName = (state.semester.calName || "课表").replace(/[\\/:*?"<>|]/g, "_");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// 备份 / 恢复
// ---------------------------------------------------------------------------

$("exportJson").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  a.download = `kebiao2ics-备份-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$("importJson").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const s = JSON.parse(await file.text());
    if (!s.semester || !Array.isArray(s.periods) || !Array.isArray(s.courses)) {
      throw new Error("文件格式不对，请选择本站导出的备份文件");
    }
    state = s;
    save();
    exitEditMode();
    renderSemester();
    renderPeriods();
    renderCourses();
    refreshOutputs();
  } catch (err) {
    alert(`恢复失败：${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

if (/MicroMessenger|\bQQ\//i.test(navigator.userAgent)) {
  $("wxTip").hidden = false;
}

fillDaySelect();
renderSemester();
renderPeriods();
renderCourses();
refreshOutputs();
