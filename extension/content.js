// ==UserScript==
// @name         复旦选课占用表
// @namespace    https://github.com/zik-wang/fdu-xk-busy
// @version      1.1.0
// @description  新版 xk.fudan.edu.cn：无法上课时间表 + 邯郸/枫林连堂跨校提示。不自动选课。
// @author       classmates
// @match        *://xk.fudan.edu.cn/*
// @match        *://*.fudan.edu.cn/course-selection/*
// @match        *://*.fudan.edu.cn/xk/*
// @icon         https://www.fudan.edu.cn/_upload/tpl/00/0e/14/template14/images/favicon.ico
// @grant        none
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "fdu-xk-busy-v1";
  const DAYS = ["一", "二", "三", "四", "五", "六", "日"];
  const PERIODS = [
    ["1", "08:00"],
    ["2", "08:55"],
    ["3", "09:55"],
    ["4", "10:50"],
    ["5", "11:45"],
    ["6", "13:30"],
    ["7", "14:25"],
    ["8", "15:25"],
    ["9", "16:20"],
    ["10", "17:15"],
    ["11", "18:30"],
    ["12", "19:25"],
    ["13", "20:20"],
    ["14", "21:15"],
  ];
  const DAY_TOKEN = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
  };

  const lessonCache = new Map();
  let selectedBlocks = [];
  let applyTimer = 0;

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        busy: Array.isArray(raw.busy) ? raw.busy : [],
        busyCampus: raw.busyCampus === "枫林" ? "枫林" : "邯郸",
        hideBusy: raw.hideBusy !== false,
        markCross: raw.markCross !== false,
        collapsed: !!raw.collapsed,
      };
    } catch {
      return {
        busy: [],
        busyCampus: "邯郸",
        hideBusy: true,
        markCross: true,
        collapsed: false,
      };
    }
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function keyOf(day, period) {
    return day + "-" + period;
  }

  function parseCampus(text) {
    const s = String(text || "");
    if (/枫林/.test(s) || /\bF\d/.test(s) || /教室[：: ]*F/i.test(s)) return "枫林";
    if (/江湾/.test(s) || /\bJ[A-Z]?\d/.test(s)) return "江湾";
    if (/张江/.test(s) || /\bZ\d/.test(s)) return "张江";
    if (/邯郸/.test(s) || /\bH(?:GX|GD)?\d/.test(s) || /光华/.test(s)) return "邯郸";
    return "";
  }

  function expandRange(from, to) {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const out = [];
    for (let n = a; n <= b; n++) out.push(n);
    return out;
  }

  function parseSlots(text) {
    const slots = [];
    const seen = new Set();
    const push = (day, from, to) => {
      if (day < 1 || day > 7) return;
      expandRange(from, to).forEach((period) => {
        if (period < 1 || period > 14) return;
        const k = keyOf(day, period);
        if (seen.has(k)) return;
        seen.add(k);
        slots.push({ day: day, period: period });
      });
    };
    const src = String(text || "");
    const longRe =
      /(星期|周)([一二三四五六日天])\s*[第]?(\d{1,2})\s*[-~～到至]\s*(\d{1,2})\s*节?/g;
    let m;
    while ((m = longRe.exec(src))) push(DAY_TOKEN[m[2]], Number(m[3]), Number(m[4]));
    const shortRe = /(?:^|[^\dA-Za-z])([一二三四五六日])\s*(\d{1,2})\s*-\s*(\d{1,2})/g;
    while ((m = shortRe.exec(src))) push(DAY_TOKEN[m[1]], Number(m[2]), Number(m[3]));
    return slots;
  }

  function toBlocks(slots) {
    const byDay = new Map();
    (slots || []).forEach((slot) => {
      const arr = byDay.get(slot.day) || [];
      arr.push(slot.period);
      byDay.set(slot.day, arr);
    });
    const blocks = [];
    byDay.forEach((periods, day) => {
      const uniq = Array.from(new Set(periods)).sort((a, b) => a - b);
      let start = uniq[0];
      let prev = uniq[0];
      for (let i = 1; i <= uniq.length; i++) {
        if (i < uniq.length && uniq[i] === prev + 1) {
          prev = uniq[i];
          continue;
        }
        blocks.push({ day: day, start: start, end: prev });
        if (i < uniq.length) {
          start = uniq[i];
          prev = uniq[i];
        }
      }
    });
    return blocks;
  }

  function slotsFromBusy() {
    return state.busy
      .map((k) => k.split("-").map(Number))
      .filter((pair) => pair.length === 2)
      .map(([day, period]) => ({ day: day, period: period }));
  }

  function isHandanFenglin(a, b) {
    return (a === "邯郸" && b === "枫林") || (a === "枫林" && b === "邯郸");
  }

  function isNoonBreak(earlierEnd, laterStart) {
    return earlierEnd === 5 && laterStart === 6;
  }

  function adjacentGap(a, b) {
    if (a.day !== b.day) return null;
    if (a.end + 1 === b.start) return { day: a.day, earlierEnd: a.end, laterStart: b.start };
    if (b.end + 1 === a.start) return { day: a.day, earlierEnd: b.end, laterStart: a.start };
    return null;
  }

  function crossingAgainst(courseBlocks, courseCampus, occBlocks, occCampus) {
    if (!isHandanFenglin(courseCampus, occCampus)) return null;
    for (let i = 0; i < courseBlocks.length; i++) {
      for (let j = 0; j < occBlocks.length; j++) {
        const gap = adjacentGap(courseBlocks[i], occBlocks[j]);
        if (!gap || isNoonBreak(gap.earlierEnd, gap.laterStart)) continue;
        return (
          "无法实现的区域跨越 · 周" +
          DAYS[gap.day - 1] +
          gap.earlierEnd +
          "节下课→" +
          gap.laterStart +
          "节上课 · " +
          occCampus +
          "↔" +
          courseCampus
        );
      }
    }
    return null;
  }

  function occupancyList() {
    const list = [
      {
        campus: state.busyCampus,
        blocks: toBlocks(slotsFromBusy()),
        slots: slotsFromBusy(),
      },
    ];
    selectedBlocks.forEach((item) => list.push(item));
    return list;
  }

  function classify(course) {
    const occ = occupancyList();
    const hits = [];
    occ.forEach((item) => {
      (course.slots || []).forEach((slot) => {
        if (
          item.slots.some((s) => s.day === slot.day && s.period === slot.period)
        ) {
          hits.push("周" + DAYS[slot.day - 1] + slot.period);
        }
      });
    });
    if (hits.length) {
      return { kind: "busy", label: "占用冲突 · " + hits.slice(0, 6).join("、") };
    }
    if (state.markCross) {
      for (let i = 0; i < occ.length; i++) {
        const note = crossingAgainst(
          course.blocks,
          course.campus,
          occ[i].blocks,
          occ[i].campus,
        );
        if (note) return { kind: "cross", label: note };
      }
    }
    return { kind: "ok", label: "" };
  }

  function walkSchedules(obj, acc, depth) {
    if (!obj || typeof obj !== "object" || depth > 8) return;
    const dayRaw = obj.weekDay ?? obj.weekday ?? obj.dayOfWeek ?? obj.day;
    const startRaw = obj.startUnit ?? obj.start ?? obj.unitStart ?? obj.startTimeUnit;
    const endRaw = obj.endUnit ?? obj.end ?? obj.unitEnd ?? obj.endTimeUnit;
    const day = Number(dayRaw);
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (day >= 1 && day <= 7 && start >= 1 && end >= 1) {
      const campus =
        parseCampus(obj.campusName || obj.campus || obj.classroom || obj.room || "") ||
        acc.campus ||
        "";
      const slots = expandRange(start, end).map((period) => ({ day: day, period: period }));
      acc.items.push({ campus: campus, slots: slots });
    }
    const text =
      obj.dateTimePlace && obj.dateTimePlace.text
        ? obj.dateTimePlace.text
        : obj.dateTimePlaceText || obj.placeTimes || obj.timePlace || "";
    if (typeof text === "string" && text) {
      const slots = parseSlots(text);
      if (slots.length) {
        acc.items.push({
          campus: parseCampus(text) || acc.campus || "",
          slots: slots,
        });
      }
    }
    Object.keys(obj).forEach((key) => {
      const val = obj[key];
      if (val && typeof val === "object") walkSchedules(val, acc, depth + 1);
    });
  }

  function lessonFromUnknown(raw) {
    if (!raw || typeof raw !== "object") return null;
    const code = String(raw.code || raw.lessonCode || raw.no || raw.lessonNo || "").trim();
    const name = String(raw.name || raw.courseName || raw.lessonName || "").trim();
    const campus =
      parseCampus(
        raw.campusName ||
          raw.campus ||
          raw.campusZh ||
          (raw.dateTimePlace && raw.dateTimePlace.text) ||
          "",
      ) || "";
    const acc = { campus: campus, items: [] };
    walkSchedules(raw, acc, 0);
    const slots = [];
    const seen = new Set();
    let foundCampus = campus;
    acc.items.forEach((item) => {
      if (item.campus && !foundCampus) foundCampus = item.campus;
      item.slots.forEach((slot) => {
        const k = keyOf(slot.day, slot.period);
        if (seen.has(k)) return;
        seen.add(k);
        slots.push(slot);
      });
    });
    if (!code && !slots.length) return null;
    return {
      code: code,
      name: name,
      campus: foundCampus,
      slots: slots,
      blocks: toBlocks(slots),
    };
  }

  function collectLessons(node, into, depth) {
    if (!node || depth > 10) return;
    if (Array.isArray(node)) {
      node.forEach((item) => {
        const lesson = lessonFromUnknown(item);
        if (lesson && lesson.code) into.set(lesson.code, lesson);
        else collectLessons(item, into, depth + 1);
      });
      return;
    }
    if (typeof node !== "object") return;
    const direct = lessonFromUnknown(node);
    if (direct && direct.code && (direct.slots.length || node.id)) {
      into.set(direct.code, direct);
    }
    Object.keys(node).forEach((key) => collectLessons(node[key], into, depth + 1));
  }

  function rememberPayload(payload) {
    if (!payload) return;
    collectLessons(payload, lessonCache, 0);
  }

  function hookNetwork() {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function () {
        return origFetch.apply(this, arguments).then((res) => {
          try {
            const url = String(res.url || "");
            if (/\/api\/v1\/student\/course-select\//.test(url)) {
              res
                .clone()
                .json()
                .then((data) => {
                  rememberPayload(data);
                  if (/selected-lessons/.test(url) && data && data.data) {
                    selectedBlocks = [];
                    const list = Array.isArray(data.data) ? data.data : [];
                    list.forEach((item) => {
                      const lesson = lessonFromUnknown(item);
                      if (!lesson || !lesson.slots.length) return;
                      selectedBlocks.push({
                        campus: lesson.campus || "邯郸",
                        blocks: lesson.blocks,
                        slots: lesson.slots,
                      });
                    });
                  }
                  scheduleApply();
                })
                .catch(() => {});
            }
          } catch (_) {}
          return res;
        });
      };
    }
    const OrigXHR = window.XMLHttpRequest;
    if (!OrigXHR) return;
    const open = OrigXHR.prototype.open;
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__fduXkUrl = String(url || "");
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          if (!/\/api\/v1\/student\/course-select\//.test(this.__fduXkUrl || "")) return;
          const data = JSON.parse(this.responseText);
          rememberPayload(data);
          scheduleApply();
        } catch (_) {}
      });
      return send.apply(this, arguments);
    };
  }

  function cookie(name) {
    const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return match ? decodeURIComponent(match[2]) : "";
  }

  function parseHash() {
    const match = /^#\/course-select\/(\d+)\/turn\/(\d+)\//.exec(location.hash || "");
    if (!match) return null;
    return { uid: match[1], turnId: match[2] };
  }

  function refreshSelected() {
    const path = parseHash();
    const token = cookie("cs-course-select-student-token");
    if (!path || !token) return;
    fetch(
      "https://xk.fudan.edu.cn/api/v1/student/course-select/selected-lessons/" +
        path.turnId +
        "/" +
        path.uid,
      {
        method: "GET",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      },
    ).catch(() => {});
  }

  function rowText(row) {
    return (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
  }

  function courseFromRow(row) {
    const text = rowText(row);
    const codeEl = row.querySelector(".lesson-code");
    const codeMatch = text.match(/[A-Z]{2,}\d{5,}(?:\.\d+)?/);
    const code = (codeEl ? codeEl.textContent.trim() : "") || (codeMatch ? codeMatch[0] : "");
    const cached = code && lessonCache.get(code);
    const slots = (cached && cached.slots.length ? cached.slots : parseSlots(text)) || [];
    const campus =
      (cached && cached.campus) ||
      parseCampus(text) ||
      "";
    return {
      code: code,
      campus: campus,
      slots: slots,
      blocks: toBlocks(slots),
    };
  }

  function listRows() {
    const out = [];
    const seen = new Set();
    document
      .querySelectorAll(
        ".el-table__body-wrapper tbody tr, .el-table__row, table tbody tr, [role='row']",
      )
      .forEach((row) => {
        if (seen.has(row)) return;
        if (row.closest("#fdu-xk-panel, #fdu-xk-banner")) return;
        if (row.closest("#pane-selectedLesson")) return;
        const text = rowText(row);
        if (!text || text.length < 8) return;
        const looksLikeCourse =
          /选课/.test(text) ||
          /星期[一二三四五六日]/.test(text) ||
          /[A-Z]{2,}\d{5,}/.test(text);
        if (!looksLikeCourse) return;
        if (!parseSlots(text).length && !row.querySelector(".lesson-code")) return;
        seen.add(row);
        out.push(row);
      });
    return out;
  }

  function clearMarks(row) {
    row.classList.remove("fdu-xk-busy", "fdu-xk-cross");
    row.style.display = "";
    const old = row.querySelector(".fdu-xk-flag");
    if (old) old.remove();
  }

  function markRow(row, result) {
    clearMarks(row);
    if (result.kind === "ok") return;
    const flag = document.createElement("div");
    flag.className = "fdu-xk-flag";
    flag.textContent = result.label;
    const cell = row.querySelector("td .cell") || row.querySelector("td") || row;
    cell.appendChild(flag);
    if (result.kind === "busy") {
      row.classList.add("fdu-xk-busy");
      if (state.hideBusy) row.style.display = "none";
    } else if (result.kind === "cross") {
      row.classList.add("fdu-xk-cross");
    }
  }

  function applyFilters() {
    const rows = listRows();
    rows.forEach((row) => markRow(row, classify(courseFromRow(row))));
    const stats = document.getElementById("fdu-xk-stats");
    if (stats) {
      const busyN = document.querySelectorAll(".fdu-xk-busy").length;
      const crossN = document.querySelectorAll(".fdu-xk-cross").length;
      stats.textContent =
        "占用格 " +
        state.busy.length +
        " · 本页占用冲突 " +
        busyN +
        " · 跨校不可达 " +
        crossN +
        " · 识别到 " +
        rows.length +
        " 行";
    }
  }

  function scheduleApply() {
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(applyFilters, 120);
  }

  function toggleBusy(key) {
    const i = state.busy.indexOf(key);
    if (i >= 0) state.busy.splice(i, 1);
    else state.busy.push(key);
    saveState();
    renderGrid();
    scheduleApply();
  }

  function renderGrid() {
    const mount = document.getElementById("fdu-xk-grid");
    if (!mount) return;
    const busy = new Set(state.busy);
    let html =
      '<table class="fdu-xk-table"><thead><tr><th>节</th>';
    DAYS.forEach((d) => {
      html += "<th>周" + d + "</th>";
    });
    html += "</tr></thead><tbody>";
    PERIODS.forEach(([n, clock]) => {
      html += "<tr><th>" + n + " " + clock + "</th>";
      DAYS.forEach((_, dayIndex) => {
        const key = keyOf(dayIndex + 1, Number(n));
        const on = busy.has(key);
        html +=
          '<td><button type="button" data-k="' +
          key +
          '" class="' +
          (on ? "on" : "") +
          '">' +
          (on ? "占" : "") +
          "</button></td>";
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    mount.innerHTML = html;
  }

  function injectStyle() {
    if (document.getElementById("fdu-xk-style")) return;
    const style = document.createElement("style");
    style.id = "fdu-xk-style";
    style.textContent = `
      #fdu-xk-banner{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#f59e0b;color:#111827;padding:8px 14px;font:14px/1.4 system-ui,sans-serif;display:flex;gap:12px;align-items:center;justify-content:space-between}
      #fdu-xk-panel{position:fixed;left:12px;top:48px;z-index:2147483647;width:420px;max-height:calc(100vh - 64px);overflow:auto;background:#111827;color:#e5e7eb;border:2px solid #f59e0b;border-radius:10px;font:12px/1.4 system-ui,sans-serif}
      #fdu-xk-panel header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#1f2937;position:sticky;top:0}
      #fdu-xk-panel h1{margin:0;font-size:13px;font-weight:600}
      #fdu-xk-panel .body{padding:8px 10px 12px}
      #fdu-xk-panel.collapsed .body{display:none}
      #fdu-xk-panel label{display:flex;gap:6px;align-items:center;margin:4px 0}
      #fdu-xk-panel select,#fdu-xk-panel button.bar{background:#111827;color:#e5e7eb;border:1px solid #4b5563;border-radius:4px;padding:2px 6px}
      .fdu-xk-table{width:100%;border-collapse:collapse}
      .fdu-xk-table th,.fdu-xk-table td{padding:1px;text-align:center}
      .fdu-xk-table th{color:#9ca3af;font-weight:500}
      .fdu-xk-table button{width:100%;min-height:20px;border:1px solid #4b5563;background:#1f2937;color:#d1d5db;border-radius:3px;cursor:pointer}
      .fdu-xk-table button.on{background:#2563eb;border-color:#2563eb;color:#fff}
      tr.fdu-xk-cross td{background:#78350f !important}
      tr.fdu-xk-busy td{background:#7f1d1d !important}
      .fdu-xk-flag{margin-top:4px;padding:2px 6px;border-radius:3px;font-size:11px;line-height:1.3}
      tr.fdu-xk-cross .fdu-xk-flag{background:#f59e0b;color:#111827}
      tr.fdu-xk-busy .fdu-xk-flag{background:#fecaca;color:#7f1d1d}
      #fdu-xk-stats{color:#9ca3af;margin-top:6px}
    `;
    document.documentElement.appendChild(style);
  }

  function injectPanel() {
    if (!document.body) return;
    injectStyle();
    if (!document.getElementById("fdu-xk-banner")) {
      const bar = document.createElement("div");
      bar.id = "fdu-xk-banner";
      bar.innerHTML =
        "<strong>复旦选课占用表已运行</strong><span>点左侧格子占住不能上课的节次。这不是学校自带功能。</span>";
      document.body.appendChild(bar);
    }
    if (document.getElementById("fdu-xk-panel")) return;
    const panel = document.createElement("aside");
    panel.id = "fdu-xk-panel";
    if (state.collapsed) panel.classList.add("collapsed");
    panel.innerHTML = `
      <header>
        <h1>无法上课时间表</h1>
        <button type="button" class="bar" id="fdu-xk-toggle">${state.collapsed ? "展开" : "收起"}</button>
      </header>
      <div class="body">
        <p style="margin:0 0 8px;color:#9ca3af">点格表示这学期这节不能排课。邯郸↔枫林连堂（非第5→第6节 12:30）标琥珀色「无法实现的区域跨越」。不自动选课。</p>
        <label>占用格所在校区
          <select id="fdu-xk-campus">
            <option value="邯郸">邯郸</option>
            <option value="枫林">枫林</option>
          </select>
        </label>
        <label><input type="checkbox" id="fdu-xk-hide"> 从搜索结果隐藏占用冲突</label>
        <label><input type="checkbox" id="fdu-xk-cross"> 标注无法实现的区域跨越</label>
        <div id="fdu-xk-grid"></div>
        <div id="fdu-xk-stats"></div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById("fdu-xk-campus").value = state.busyCampus;
    document.getElementById("fdu-xk-hide").checked = state.hideBusy;
    document.getElementById("fdu-xk-cross").checked = state.markCross;
    document.getElementById("fdu-xk-toggle").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      panel.classList.toggle("collapsed", state.collapsed);
      document.getElementById("fdu-xk-toggle").textContent = state.collapsed ? "展开" : "收起";
      saveState();
    });
    document.getElementById("fdu-xk-campus").addEventListener("change", (ev) => {
      state.busyCampus = ev.target.value === "枫林" ? "枫林" : "邯郸";
      saveState();
      scheduleApply();
    });
    document.getElementById("fdu-xk-hide").addEventListener("change", (ev) => {
      state.hideBusy = ev.target.checked;
      saveState();
      scheduleApply();
    });
    document.getElementById("fdu-xk-cross").addEventListener("change", (ev) => {
      state.markCross = ev.target.checked;
      saveState();
      scheduleApply();
    });
    document.getElementById("fdu-xk-grid").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-k]");
      if (!btn) return;
      toggleBusy(btn.getAttribute("data-k"));
    });
    renderGrid();
  }

  function watchDom() {
    const obs = new MutationObserver(() => scheduleApply());
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => {
      refreshSelected();
      scheduleApply();
    });
  }

  function boot() {
    const go = function () {
      try {
        injectPanel();
      } catch (err) {
        console.error("[fdu-xk-busy] panel", err);
      }
      try {
        hookNetwork();
      } catch (err) {
        console.error("[fdu-xk-busy] hook", err);
      }
      try {
        watchDom();
      } catch (err) {}
      try {
        refreshSelected();
      } catch (err) {}
      scheduleApply();
    };
    if (document.body) go();
    else document.addEventListener("DOMContentLoaded", go);
    setTimeout(go, 800);
    setTimeout(go, 2500);
  }

  boot();
})();
