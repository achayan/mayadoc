"use strict";

const KINDS = {
  c: { label: "Commands", tag: "cmd" },
  r: { label: "Runtime", tag: "rtc" },
  o: { label: "OpenMaya", tag: "cls" },
  m: { label: "Members", tag: "fn" },
  n: { label: "Nodes", tag: "node" },
};
const BROWSE_KINDS = ["c", "o", "n", "r"];
const MAX_RESULTS = 100;

const state = {
  versions: [],
  version: null,
  meta: null,
  index: [],
  files: {},
  kind: "c",
  query: "",
  results: [],
  sel: -1,
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (_) { return null; }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1400);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch (_) {
    toast("Copy failed");
  }
}

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + ": " + res.status);
  return res.json();
}

function file(name) {
  const key = state.version + "/" + name;
  if (!state.files[key]) state.files[key] = fetchJSON("data/" + key + ".json");
  return state.files[key];
}

/* ---------- search ---------- */

function initials(name) {
  return (name[0] + name.slice(1).replace(/[^A-Z0-9]/g, "")).toLowerCase();
}

// indexes where a camelCase / dotted "word" starts
function humps(name) {
  const out = new Set([0]);
  for (let i = 1; i < name.length; i++) {
    if (/[A-Z0-9]/.test(name[i]) || /[._]/.test(name[i - 1])) out.add(i);
  }
  return out;
}

function prepareIndex(rows) {
  return rows.map(([k, name, sub, uses]) => {
    const dot = k === "m" ? name.indexOf(".") : -1;
    const member = dot >= 0 ? name.slice(dot + 1) : null;
    return {
      k, name, sub, member, pop: uses ? Math.min(Math.log10(uses + 1) * 6, 24) : 0,
      lower: name.toLowerCase(), subLower: (sub || "").toLowerCase(), ini: initials(name), humps: humps(name),
      memberLower: member && member.toLowerCase(), memberIni: member && initials(member), memberHumps: member && humps(member),
    };
  });
}

function matchScore(q, s, ini, hmp) {
  if (s === q) return 1000;
  if (s.startsWith(q)) return 800 - Math.min(s.length - q.length, 100);
  if (q.length >= 2 && ini.startsWith(q)) return 700 - Math.min(ini.length - q.length, 20) * 5 - Math.min(s.length, 60) * 0.5;
  let i = s.indexOf(q), best = 0;
  while (i >= 0) {
    best = Math.max(best, (hmp.has(i) ? 650 : 500) - Math.min(i, 50) - Math.min(s.length, 60) * 0.5);
    i = s.indexOf(q, i + 1);
  }
  if (best) return best;
  // subsequence
  let pos = 0, gaps = 0;
  for (const ch of q) {
    const found = s.indexOf(ch, pos);
    if (found < 0) return 0;
    gaps += found - pos;
    pos = found + 1;
  }
  return q.length >= 3 ? Math.max(1, 200 - gaps * 4 - s.length) : 0;
}

const KIND_BONUS = { c: 30, o: 25, n: 20, m: 0, r: -10 };

function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const terms = q.split(/\s+/);
  if (terms.length > 1) {
    // every word must appear in the name or summary; name hits count more
    for (const e of state.index) {
      let s = 300;
      for (const t of terms) {
        if (e.lower.includes(t)) s += 60;
        else if (e.subLower.includes(t)) s += 20;
        else { s = 0; break; }
      }
      if (s) out.push([s + KIND_BONUS[e.k] + e.pop - Math.min(e.name.length, 60) * 0.5, e]);
    }
  } else for (const e of state.index) {
    let s = matchScore(q, e.lower, e.ini, e.humps);
    if (e.member && !q.includes(".")) s = Math.max(s, matchScore(q, e.memberLower, e.memberIni, e.memberHumps) - 40);
    if (s > 0) out.push([s + KIND_BONUS[e.k] + e.pop, e]);
  }
  out.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
  return out.map((x) => x[1]);
}

/* ---------- sidebar ---------- */

function hrefFor(e) {
  if (e.k === "m") {
    const dot = e.name.indexOf(".");
    return "#/o/" + enc(e.name.slice(0, dot)) + "/" + enc(e.name.slice(dot + 1));
  }
  return "#/" + e.k + "/" + enc(e.name);
}

function renderKinds() {
  const counts = {};
  const pool = state.query ? state.results : state.index;
  for (const e of pool) counts[e.k] = (counts[e.k] || 0) + 1;
  const kinds = state.query ? ["all", "c", "o", "m", "n", "r"] : BROWSE_KINDS;
  $("#kinds").innerHTML = kinds
    .map((k) => {
      const label = k === "all" ? "All" : KINDS[k].label;
      const n = k === "all" ? pool.length : counts[k] || 0;
      const on = state.query ? (state.searchKind || "all") === k : state.kind === k;
      return `<button data-kind="${k}" class="${on ? "on" : ""}">${label} <span class="muted">${n}</span></button>`;
    })
    .join("");
}

function renderList() {
  let items;
  if (state.query) {
    const k = state.searchKind || "all";
    items = k === "all" ? state.results : state.results.filter((e) => e.k === k);
    $("#listMeta").textContent = items.length
      ? `${items.length} match${items.length === 1 ? "" : "es"}${items.length > MAX_RESULTS ? ` · top ${MAX_RESULTS}` : ""} · ↑↓ Enter`
      : "";
    items = items.slice(0, MAX_RESULTS);
  } else {
    items = state.index.filter((e) => e.k === state.kind);
    $("#listMeta").textContent = `${items.length} ${KINDS[state.kind].label.toLowerCase()}`;
  }
  state.visible = items;
  if (state.sel >= items.length) state.sel = items.length - 1;
  const current = location.hash.split("/").slice(0, 3).join("/");
  $("#list").innerHTML = items.length
    ? items
        .map((e, i) => {
          const href = hrefFor(e);
          const sel = state.query ? i === state.sel : href === current;
          return `<li class="${sel ? "sel" : ""}" role="option"><a href="${href}">
            <span class="row1"><span class="kind ${e.k}">${KINDS[e.k].tag}</span><span class="name">${esc(e.name)}</span></span>
            ${e.sub ? `<span class="sub">${esc(e.sub)}</span>` : ""}</a></li>`;
        })
        .join("")
    : `<li class="empty">No matches</li>`;
}

function refreshSidebar() {
  renderKinds();
  renderList();
}

function moveSelection(delta) {
  const n = (state.visible || []).length;
  if (!n) return;
  state.sel = (state.sel + delta + n) % n;
  renderList();
  const li = $("#list").children[state.sel];
  if (li) li.scrollIntoView({ block: "nearest" });
}

/* ---------- linkifying ---------- */

let classNames = null;
let commandNames = null;

function linkClasses(text) {
  return esc(text).replace(/\bM[A-Z][A-Za-z0-9]+\b/g, (m) => (classNames && classNames.has(m) ? `<a href="#/o/${m}">${m}</a>` : m));
}

function linkCommands(text) {
  return esc(text).replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (w) => {
    if (commandNames && commandNames.c.has(w)) return `<a href="#/c/${w}">${w}</a>`;
    if (commandNames && commandNames.r.has(w)) return `<a href="#/r/${w}">${w}</a>`;
    return w;
  });
}

// minimal inline markdown for hand-written notes: `code` and **bold**
function md(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/* ---------- syntax highlighting (no dependencies, works offline) ---------- */

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ")
);
const PY_BUILTINS = new Set(
  "print len range sorted reversed list dict set tuple str int float bool round zip enumerate isinstance super min max sum abs any all open map filter getattr setattr hasattr type object repr format staticmethod classmethod property Exception RuntimeError ValueError TypeError KeyError".split(" ")
);
const MEL_KEYWORDS = new Set("proc global string int float vector matrix if else for in while do switch case default break continue return true false on off yes no source".split(" "));
const PY_TOKEN = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(@[\w.]+)|([A-Za-z_]\w*)/g;
const MEL_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\$\w+)|((?<![\w)\]])-[A-Za-z]\w*)|([A-Za-z_]\w*)/g;
const API_MODULE = /\b(?:om|oma|omui|omr|OpenMaya|OpenMayaAnim|OpenMayaUI|OpenMayaRender)\.$/;

function nameSets() {
  if (!state.names || state.names.version !== state.version) {
    const sets = { c: new Set(), r: new Set(), o: new Set(), version: state.version };
    for (const e of state.index) if (sets[e.k]) sets[e.k].add(e.name);
    state.names = sets;
  }
  return state.names;
}

function span(cls, text) {
  return `<span class="tk-${cls}">${esc(text)}</span>`;
}

function highlight(code, lang = "python") {
  const names = nameSets();
  const mel = lang === "mel";
  const re = mel ? MEL_TOKEN : PY_TOKEN;
  re.lastIndex = 0;
  let out = "", last = 0, prevWord = "", m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    last = re.lastIndex;
    const [tok] = m;
    if (m[1]) out += span("com", tok);
    else if (m[2]) out += span("str", tok);
    else if (m[3]) out += span("num", tok);
    else if (mel && m[4]) out += span("var", tok);
    else if (mel && m[5]) out += span("flag", tok);
    else if (!mel && m[4]) out += span("dec", tok);
    else {
      const before = code.slice(Math.max(0, m.index - 16), m.index);
      if (mel) {
        if (MEL_KEYWORDS.has(tok)) out += span("kw", tok);
        else if (names.c.has(tok)) out += `<a class="tk-link" href="#/c/${tok}">${tok}</a>`;
        else if (names.r.has(tok)) out += `<a class="tk-link" href="#/r/${tok}">${tok}</a>`;
        else out += esc(tok);
      } else if (/\bcmds\.$/.test(before) && names.c.has(tok)) {
        out += `<a class="tk-link" href="#/c/${tok}">${tok}</a>`;
      } else if (API_MODULE.test(before) && names.o.has(tok)) {
        out += `<a class="tk-link" href="#/o/${tok}">${tok}</a>`;
      } else if (PY_KEYWORDS.has(tok)) out += span(tok === "None" || tok === "True" || tok === "False" ? "const" : "kw", tok);
      else if (prevWord === "def" || prevWord === "class") out += span("fn", tok);
      else if (tok === "self" || tok === "cls") out += span("self", tok);
      else if (PY_BUILTINS.has(tok)) out += span("bi", tok);
      else out += esc(tok);
    }
    prevWord = m[5] || m[6] ? tok : "";
  }
  return out + esc(code.slice(last));
}

function codeBlock(text, lang = "python") {
  return `<div class="code"><button class="btn copy" data-copy="${esc(text)}">Copy</button><pre class="lang-${lang}">${highlight(text, lang)}</pre></div>`;
}

/* ---------- pages ---------- */

function page(html) {
  const main = $("#main");
  main.innerHTML = `<div class="page-wrap"><div class="page">${html}</div><nav class="toc" id="toc" aria-label="On this page"></nav></div>${footer()}`;
  main.scrollTop = 0;
}

function footer() {
  const year = new Date().getFullYear();
  const version = state.meta ? ` · Data from Maya ${esc(String(state.meta.apiVersion).slice(0, 4))}` : "";
  return `<footer class="site-footer"><div class="page-wrap"><div>
    <p>Made by <strong>Kurianos</strong> © ${year}${version}</p>
    <p class="muted">Autodesk and Maya are registered trademarks of Autodesk, Inc. This is an independent reference, not affiliated with or endorsed by Autodesk.</p>
  </div></div></footer>`;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildToc() {
  const toc = $("#toc");
  if (!toc) return;
  const heads = [...document.querySelectorAll(".page h2")];
  const used = new Set();
  for (const h of heads) {
    if (!h.id) {
      let id = "sec-" + slug(h.childNodes[0].textContent);
      while (used.has(id)) id += "-";
      h.id = id;
    }
    used.add(h.id);
  }
  if (heads.length < 2) {
    toc.innerHTML = "";
    return;
  }
  toc.innerHTML =
    `<div class="toc-title">On this page</div>` +
    heads
      .map((h) => {
        const count = h.querySelector(".muted");
        return `<a href="#${h.id}" data-jump="${h.id}">${esc(h.childNodes[0].textContent.trim())}${count ? ` <span class="muted">${esc(count.textContent)}</span>` : ""}</a>`;
      })
      .join("");
  updateTocActive();
}

function updateTocActive() {
  const toc = $("#toc");
  if (!toc || !toc.children.length) return;
  const mainTop = $("#main").getBoundingClientRect().top;
  let active = null;
  for (const h of document.querySelectorAll(".page h2")) {
    if (h.getBoundingClientRect().top - mainTop <= 90) active = h.id;
  }
  for (const a of toc.querySelectorAll("a")) a.classList.toggle("on", a.dataset.jump === active);
}

function notFound(what, name) {
  page(`<h1>Not found</h1><p class="lead">No ${esc(what)} named <code>${esc(name)}</code> in Maya ${esc(state.meta.version)}.</p>`);
}

function renderHome() {
  const c = state.meta.counts;
  const card = (n, l, href) => `<a class="card" href="${href}"><div class="n">${n.toLocaleString()}</div><div class="l">${l}</div></a>`;
  const quick = [
    ["c", "xform"], ["c", "ls"], ["c", "setAttr"], ["c", "listConnections"], ["c", "skinCluster"],
    ["o", "MFnMesh"], ["o", "MDagPath"], ["o", "MSelectionList"], ["o", "MPxNode"],
    ["n", "transform"], ["n", "mesh"], ["n", "joint"], ["n", "skinCluster"],
  ];
  page(`
    <div class="crumbs">Maya ${esc(state.meta.version)} · API ${esc(state.meta.apiVersion)} · Python ${esc(state.meta.python)}</div>
    <h1>Maya developer reference</h1>
    <p class="lead">Generated directly from <code>mayapy</code>: commands with every flag, runtime commands with the code behind each menu item, OpenMaya 2.0 classes, and node types with their attributes. Works offline.</p>
    <div class="cards">
      ${card(c.commands, "Commands", "#/list/c")}
      ${card(c.runtime, "Runtime commands", "#/list/r")}
      ${card(c.classes, "OpenMaya 2.0 classes", "#/list/o")}
      ${card(c.members, "Class members", "#/list/o")}
      ${card(c.nodes, "Node types", "#/list/n")}
    </div>
    ${
      state.meta.withExamples
        ? `<h2>Examples <span class="muted">${c.examples} examples · ${c.testedExamples} run in mayapy</span></h2>
    <div class="chips">${["c", "o"]
      .flatMap((k) => state.meta.withExamples[k].map((n) => `<a href="#/${k}/${enc(n)}"><span class="kind ${k}">${KINDS[k].tag}</span> ${esc(n)}</a>`))
      .join("")}</div>`
        : ""
    }
    <h2>Jump to</h2>
    <div class="chips">${quick.map(([k, n]) => `<a href="#/${k}/${n}"><span class="kind ${k}">${KINDS[k].tag}</span> ${n}</a>`).join("")}</div>
    <h2>Search tips</h2>
    <table class="tbl-wrap"><tbody>
      <tr><td class="mono"><kbd>/</kbd></td><td>Focus search from anywhere</td></tr>
      <tr><td class="mono">lc</td><td>CamelCase initials: finds <code>listConnections</code>, <code>lockNode</code>…</td></tr>
      <tr><td class="mono">getPoints</td><td>Finds methods across every OpenMaya class</td></tr>
      <tr><td class="mono">MFnMesh.set</td><td>Methods of one class</td></tr>
      <tr><td class="mono">blend shape</td><td>Runtime commands show the menu item's tooltip, so plain words work too</td></tr>
    </tbody></table>`);
}

/* commands */

const PY_VALUE = {
  String: "'name'", Name: "'node'", Script: "my_callback", Int: "0", UnsignedInt: "0", Int64: "0",
  Float: "0.0", Length: "0.0", Angle: "0.0", Time: "1.0", bool: "True",
  TimeRange: "(1, 10)", FloatRange: "(0.0, 1.0)", IndexRange: "(0, 1)", "String[]": "['a', 'b']", "Int[]": "[0, 1]",
};
const MEL_VALUE = {
  String: '"name"', Name: '"node"', Script: '"myProc"', Int: "0", UnsignedInt: "0", Int64: "0",
  Float: "0.0", Length: "0.0", Angle: "0.0", Time: "1.0", bool: "true",
  TimeRange: '"1:10"', FloatRange: '"0.0:1.0"', IndexRange: '"0:1"', "String[]": '"a" "b"', "Int[]": "0 1",
};

function buildSnippets(name, flags, picked, mode) {
  const py = [], mel = [];
  if (mode !== "create") {
    py.push(`${mode}=True`);
    mel.push(mode === "edit" ? "-e" : "-q");
  }
  for (const f of flags) {
    if (!picked.has(f[1])) continue;
    const [short, long, types, , queryArg] = f;
    const passArgs = mode !== "query" || queryArg === "mandatory";
    if (!types.length || !passArgs) {
      py.push(`${long}=True`);
      mel.push(`-${short}`);
    } else {
      const pv = types.map((t) => PY_VALUE[t] || "None");
      py.push(`${long}=${pv.length > 1 ? "(" + pv.join(", ") + ")" : pv[0]}`);
      mel.push(`-${short} ${types.map((t) => MEL_VALUE[t] || '""').join(" ")}`);
    }
  }
  const target = mode === "create" ? "" : "'node'";
  const pyArgs = [target, ...py].filter(Boolean);
  const pyCall = pyArgs.length > 3 ? `cmds.${name}(\n    ${pyArgs.join(",\n    ")}\n)` : `cmds.${name}(${pyArgs.join(", ")})`;
  const result = mode === "query" ? "value = " : "";
  return {
    python: `from maya import cmds\n\n${result}${pyCall}`,
    mel: `${mode === "query" ? "$value = `" : ""}${[name, ...mel, mode === "create" ? "" : '"node"'].filter(Boolean).join(" ")}${mode === "query" ? "`" : ""};`,
  };
}

function examplesSection(note) {
  if (!note || !note.examples.length) return "";
  return `<h2 id="examples">Examples <span class="muted">${note.examples.length}</span></h2>${note.examples
    .map(
      (ex) => `<h3 class="ex-title">${md(ex.title)} ${
        ex.tested
          ? `<span class="tag ok" title="Run in mayapy by notes/test_examples.py">tested</span>`
          : `<span class="tag" title="Needs Maya's UI, so it isn't run by the test suite">UI · not run</span>`
      }</h3>${ex.text ? `<p>${md(ex.text)}</p>` : ""}${codeBlock(ex.code)}`
    )
    .join("")}`;
}

function gotchasSection(note) {
  if (!note || !note.gotchas.length) return "";
  return `<h2>Gotchas</h2><ul class="gotchas">${note.gotchas.map((g) => `<li>${md(g)}</li>`).join("")}</ul>`;
}

function exampleBadge(note) {
  if (!note || !note.examples.length) return "";
  const tested = note.examples.filter((e) => e.tested).length;
  return `<a class="badge accent" href="#examples" data-jump="examples">${note.examples.length} example${note.examples.length > 1 ? "s" : ""}${tested ? ` · ${tested} tested` : ""}</a>`;
}

function relatedHref(item) {
  return item.kind ? `#/${item.kind}/${enc(item.name)}` : null;
}

function relatedLink(item) {
  const href = relatedHref(item);
  const tag = item.kind ? `<span class="kind ${item.kind}">${KINDS[item.kind].tag}</span> ` : "";
  return href ? `<a href="${href}">${tag}${esc(item.name)}</a>` : `<span class="muted">${esc(item.name)}</span>`;
}

function relatedChips(note, auto) {
  let items = note ? note.related.flatMap((g) => g.items) : [];
  if (!items.length && auto) {
    // well-supported co-usage first, then similar commands, then weaker co-usage
    const strong = auto.together.filter(([, c]) => c >= 10).map(([n]) => n);
    const weak = auto.together.filter(([, c]) => c < 10).map(([n]) => n);
    items = [...new Set([...strong, ...auto.similar, ...weak])].slice(0, 10).map((n) => ({ name: n, kind: "c" }));
  }
  if (!items.length) return "";
  return `<div class="related-chips"><a href="#related" id="jumpRelated" class="muted">Related</a><div class="chips">${items.map(relatedLink).join("")}</div></div>`;
}

function chipList(names, kind, counts) {
  return `<div class="chips">${names
    .map((n, i) => {
      const c = counts && counts[i];
      const title = c ? ` title="Used together in ${c} Maya script procedures"` : "";
      return `<a href="#/${kind}/${enc(n)}"${title}><span class="kind ${kind}">${KINDS[kind].tag}</span> ${esc(n)}</a>`;
    })
    .join("")}</div>`;
}

function relatedSection(note, auto) {
  let html = "";
  if (note && note.related.length) {
    html += note.related
      .map(
        (group) => `${group.title ? `<h3 class="ex-title">${md(group.title)}</h3>` : ""}
        <div class="related">${group.items
          .map((item) => `<div class="related-row"><div class="related-name">${relatedLink(item)}</div><div>${md(item.text)}</div></div>`)
          .join("")}</div>`
      )
      .join("");
  }
  if (auto) {
    const curated = new Set(note ? note.related.flatMap((g) => g.items.map((i) => i.name)) : []);
    const together = auto.together.filter(([n]) => !curated.has(n));
    const similar = auto.similar.filter((n) => !curated.has(n));
    if (together.length) {
      html += `<h3 class="ex-title">Often used together</h3>
        <p class="muted small">Commands that show up in the same procedures in Maya's own scripts, most specific pairings first. Hover a command to see how many procedures use both.</p>
        ${chipList(together.map((t) => t[0]), "c", together.map((t) => t[1]))}`;
    }
    if (similar.length) {
      html += `<h3 class="ex-title">Similar commands</h3>
        <p class="muted small">Same command family or mostly the same flags.</p>${chipList(similar, "c")}`;
    }
    if (auto.node) {
      html += `<h3 class="ex-title">Node type</h3><p class="muted small">This command creates or edits a node of the same name.</p>${chipList([auto.node], "n")}`;
    }
    if (auto.menus.length) {
      html += `<h3 class="ex-title">Menu items that run it</h3>${chipList(auto.menus, "r")}`;
    }
  }
  return `<h2 id="related">Related</h2>${html || `<p class="muted">No related commands found.</p>`}`;
}

async function renderCommand(name) {
  const cmds = await file("cmds");
  const entry = cmds[name];
  if (!entry) return notFound("command", name);
  const [synopsis, allFlags, note, auto] = entry;
  const flagUses = (auto && auto.flagUses) || {};
  const longs = new Set(allFlags.map((f) => f[1]));
  const modes = ["create", ...["edit", "query"].filter((m) => longs.has(m))];
  const flags = allFlags.filter((f) => f[1] !== "edit" && f[1] !== "query");
  const flagNotes = (note && note.flags) || {};
  const hasUsage = Object.keys(flagUses).length > 0;
  const ui = { lang: storage("lang") || "python", mode: "create", picked: new Set(), filter: "", sort: hasUsage ? storage("flagSort") || "used" : "name" };

  page(`
    <div class="crumbs"><span class="kind c">cmd</span> maya.cmds</div>
    <h1>${esc(name)}</h1>
    ${note ? note.summary.map((p) => `<p class="lead">${md(p)}</p>`).join("") : ""}
    <div class="badges">
      <span class="badge">${flags.length} flags</span>
      ${auto && auto.uses ? `<span class="badge" title="Calls found in the MEL and Python scripts that ship with Maya">used ${auto.uses.toLocaleString()}× in Maya's scripts</span>` : ""}
      ${modes.slice(1).map((m) => `<span class="badge accent">${m}</span>`).join("")}
      ${exampleBadge(note)}
    </div>
    ${relatedChips(note, auto)}
    <div class="code"><pre>${esc(synopsis)}</pre></div>
    ${note && note.returns.length ? `<h2>Returns</h2>${note.returns.map((p) => `<p>${md(p)}</p>`).join("")}` : ""}
    ${
      note && (note.summary.length || note.examples.length)
        ? ""
        : `<p class="callout">No notes for this command yet. Flag names and types come from Maya; summaries and flag descriptions come from <code>notes/descriptions/</code>, and examples and gotchas from <code>notes/commands/${esc(name)}.md</code>.</p>`
    }
    ${examplesSection(note)}
    ${gotchasSection(note)}
    <h2>Snippet</h2>
    <div class="tabs" id="snipTabs"></div>
    <div id="snippet"></div>
    <p class="muted" style="font-size:12.5px">Tick flags below to add them. Values are placeholders based on each flag's type.</p>
    <h2>Flags</h2>
    <div class="toolbar"><input class="filter" id="flagFilter" placeholder="Filter flags…" autocomplete="off">
      ${hasUsage ? `<div class="tabs" id="flagSort"></div>` : ""}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th></th><th>Flag</th><th>Arguments</th>${note ? "<th>Description</th>" : ""}${hasUsage ? `<th title="Times this flag appears in Maya's own scripts">Used</th>` : ""}</tr></thead>
      <tbody id="flagRows"></tbody>
    </table></div>
    ${relatedSection(note, auto)}`);
  const jump = $("#jumpRelated");
  if (jump) jump.addEventListener("click", (ev) => { ev.preventDefault(); $("#related").scrollIntoView({ behavior: "smooth" }); });

  const draw = () => {
    $("#snipTabs").innerHTML =
      ["python", "mel"].map((l) => `<button data-lang="${l}" class="${ui.lang === l ? "on" : ""}">${l === "python" ? "Python" : "MEL"}</button>`).join("") +
      (modes.length > 1 ? `<span class="sep"></span>` + modes.map((m) => `<button data-mode="${m}" class="${ui.mode === m ? "on" : ""}">${m}</button>`).join("") : "");
    const s = buildSnippets(name, flags, ui.picked, ui.mode);
    $("#snippet").innerHTML = codeBlock(s[ui.lang], ui.lang);
  };
  const drawRows = () => {
    const q = ui.filter.toLowerCase();
    const rows = flags.filter(
      (f) => !q || f[0].toLowerCase().includes(q) || f[1].toLowerCase().includes(q) || (flagNotes[f[1]] || "").toLowerCase().includes(q)
    );
    if (ui.sort === "used") rows.sort((a, b) => (flagUses[b[1]] || 0) - (flagUses[a[1]] || 0) || a[1].localeCompare(b[1]));
    if (hasUsage) {
      $("#flagSort").innerHTML = ["used", "name"].map((k) => `<button data-sort="${k}" class="${ui.sort === k ? "on" : ""}">${k === "used" ? "Most used" : "A–Z"}</button>`).join("");
    }
    const maxUse = Math.max(1, ...Object.values(flagUses));
    $("#flagRows").innerHTML = rows.length
      ? rows
          .map(([short, long, types, multi, queryArg]) => {
            const picked = ui.picked.has(long);
            const tags = [multi ? "multi-use" : "", queryArg ? `query arg ${queryArg}` : ""].filter(Boolean);
            const desc = flagNotes[long];
            return `<tr class="clickable ${picked ? "picked" : ""}" data-flag="${esc(long)}">
              <td><input type="checkbox" ${picked ? "checked" : ""} aria-label="Add ${esc(long)}"></td>
              <td class="mono">${esc(long)}<div class="muted">-${esc(short)}</div>${tags.length ? `<div>${tags.map((n) => `<span class="tag">${n}</span>`).join("")}</div>` : ""}</td>
              <td>${types.length ? types.map((t) => `<span class="type">${esc(t)}</span>`).join(" ") : `<span class="muted">—</span>`}</td>
              ${note ? `<td class="desc">${desc ? md(desc) : ""}</td>` : ""}
              ${hasUsage ? `<td class="uses">${flagUses[long] ? `<span class="bar" style="--w:${Math.max(4, Math.round((flagUses[long] / maxUse) * 48))}px"></span>${flagUses[long].toLocaleString()}` : `<span class="muted">—</span>`}</td>` : ""}</tr>`;
          })
          .join("")
      : `<tr><td colspan="6" class="empty">No flags match</td></tr>`;
  };
  draw();
  drawRows();

  $("#snipTabs").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.lang) storage("lang", (ui.lang = b.dataset.lang));
    if (b.dataset.mode) ui.mode = b.dataset.mode;
    draw();
  });
  if (hasUsage) {
    $("#flagSort").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-sort]");
      if (!b) return;
      storage("flagSort", (ui.sort = b.dataset.sort));
      drawRows();
    });
  }
  $("#flagFilter").addEventListener("input", (ev) => {
    ui.filter = ev.target.value;
    drawRows();
  });
  $("#flagRows").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-flag]");
    if (!tr) return;
    const f = tr.dataset.flag;
    ui.picked.has(f) ? ui.picked.delete(f) : ui.picked.add(f);
    drawRows();
    draw();
  });
}

/* runtime commands */

async function renderRuntime(name) {
  const runtime = await file("runtime");
  const entry = runtime[name];
  if (!entry) return notFound("runtime command", name);
  const [lang, command, annotation, categories] = entry;
  await ensureCommandNames();
  const menus = categories.filter((c) => c.startsWith("Menu items."));
  const other = categories.filter((c) => !c.startsWith("Menu items."));
  const pyCall = `from maya import mel\n\nmel.eval('${name}')`;
  page(`
    <div class="crumbs"><span class="kind r">rtc</span> runTimeCommand</div>
    <h1>${esc(name)}</h1>
    ${annotation ? `<p class="lead">${esc(annotation)}</p>` : ""}
    <div class="badges"><span class="badge accent">${esc(lang || "mel")}</span></div>
    ${menus.length ? `<h2>Menu location</h2><div class="chips">${menus.map((m) => `<span class="badge">${esc(m.replace("Menu items.", "").split(".").join(" › "))}</span>`).join("")}</div>` : ""}
    ${other.length ? `<h2>Category</h2><div class="chips">${other.map((m) => `<span class="badge">${esc(m.split(".").join(" › "))}</span>`).join("")}</div>` : ""}
    <h2>Runs</h2>
    ${codeBlock(command, lang === "python" ? "python" : "mel")}
    <p class="muted" style="font-size:12.5px">Names that are commands or runtime commands are linked. Other names are usually MEL procedures; use <code>whatIs "procName"</code> in Maya to find their source file.</p>
    <h2>Call it</h2>
    ${codeBlock(pyCall)}`);
}

/* OpenMaya classes */

async function ensureClasses() {
  const om2 = await file("om2");
  if (!classNames || classNames.version !== state.version) {
    classNames = new Set(Object.keys(om2));
    classNames.version = state.version;
  }
  return om2;
}

async function ensureCommandNames() {
  if (commandNames && commandNames.version === state.version) return;
  const [cmds, runtime] = await Promise.all([file("cmds"), file("runtime")]);
  commandNames = { c: new Set(Object.keys(cmds)), r: new Set(Object.keys(runtime)), version: state.version };
}

async function renderClass(name, memberName) {
  const om2 = await ensureClasses();
  const entry = om2[name];
  if (!entry) return notFound("class", name);
  const [module, bases, doc, members, note] = entry;
  const subclasses = Object.keys(om2).filter((k) => om2[k][1].includes(name)).sort();
  const chain = [];
  for (let b = bases[0]; b && om2[b]; b = om2[b][1][0]) chain.unshift(b);

  page(`
    <div class="crumbs"><span class="kind o">cls</span> ${esc(module)}${chain.map((b) => ` › <a href="#/o/${b}">${b}</a>`).join("")}</div>
    <h1>${esc(name)}</h1>
    ${note ? note.summary.map((p) => `<p class="lead">${md(p)}</p>`).join("") : ""}
    <div class="badges">
      ${exampleBadge(note)}
      <span class="badge">${members.filter((m) => m[1] === "method").length} methods</span>
      <span class="badge">${members.filter((m) => m[1] === "property").length} properties</span>
      <span class="badge">${members.filter((m) => m[1] === "constant").length} constants</span>
    </div>
    ${doc ? `<div class="code"><pre class="docpre">${linkClasses(doc)}</pre></div>` : ""}
    ${note && note.examples.length ? "" : codeBlock(`import ${module} as om\n\nobj = om.${name}()`)}
    ${examplesSection(note)}
    ${gotchasSection(note)}
    ${note && note.related.length ? relatedSection(note, null) : ""}
    ${subclasses.length ? `<h2>Subclasses</h2><div class="chips">${subclasses.map((s) => `<a href="#/o/${s}">${s}</a>`).join("")}</div>` : ""}
    <div class="toolbar" style="margin-top:26px"><input class="filter" id="memberFilter" placeholder="Filter members…" autocomplete="off"></div>
    <div id="members"></div>`);

  const section = (title, list, fn) => (list.length ? `<h2>${title} <span class="muted">${list.length}</span></h2>${list.map(fn).join("")}` : "");
  const memberHtml = (m) => `
    <div class="member ${m[0] === memberName ? "target" : ""}" id="m-${esc(m[0])}">
      <h3><a href="#/o/${enc(name)}/${enc(m[0])}">${esc(m[0])}</a> ${m[1] === "property" ? '<span class="tag">property</span>' : ""}</h3>
      ${m[2] ? `<pre class="docpre">${linkClasses(m[2])}</pre>` : `<span class="muted">No docstring</span>`}
    </div>`;
  const draw = (q) => {
    q = q.toLowerCase();
    const list = members.filter((m) => !q || m[0].toLowerCase().includes(q));
    const constants = list.filter((m) => m[1] === "constant");
    $("#members").innerHTML =
      section("Methods", list.filter((m) => m[1] === "method"), memberHtml) +
      section("Properties", list.filter((m) => m[1] === "property"), memberHtml) +
      (constants.length
        ? `<h2>Constants <span class="muted">${constants.length}</span></h2><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${constants
            .map((m) => `<tr id="m-${esc(m[0])}"><td class="mono">${esc(m[0])}</td><td class="mono muted">${esc(m[3] ?? "")}</td></tr>`)
            .join("")}</tbody></table></div>`
        : "") || `<p class="empty">No members match</p>`;
  };
  draw("");
  $("#memberFilter").addEventListener("input", (ev) => draw(ev.target.value));
  if (memberName) {
    const el = document.getElementById("m-" + memberName);
    if (el) el.scrollIntoView({ block: "start" });
  }
}

/* nodes */

async function renderNode(name) {
  const nodes = await file("nodes");
  const entry = nodes[name];
  if (!entry) return notFound("node type", name);
  const [abstract, inherits, children, declared] = entry;
  const ui = { inherited: storage("inherited") !== "0", filter: "" };
  const snippet = abstract
    ? `from maya import cmds\n\n# abstract type: list nodes derived from it\nnodes = cmds.ls(type='${name}')`
    : `from maya import cmds\n\nnode = cmds.createNode('${name}')\nall_nodes = cmds.ls(type='${name}')`;

  page(`
    <div class="crumbs"><span class="kind n">node</span> ${inherits.map((b) => `<a href="#/n/${enc(b)}">${esc(b)}</a> ›`).join(" ")}</div>
    <h1>${esc(name)}</h1>
    <div class="badges">
      ${abstract ? `<span class="badge accent">abstract</span>` : ""}
      <span class="badge">${declared.length} own attributes</span>
      <span class="badge">${children.length} derived types</span>
    </div>
    ${codeBlock(snippet)}
    ${children.length ? `<h2>Derived types</h2><div class="chips">${children.map((c) => `<a href="#/n/${enc(c)}">${esc(c)}</a>`).join("")}</div>` : ""}
    <h2>Attributes</h2>
    <div class="toolbar">
      <input class="filter" id="attrFilter" placeholder="Filter attributes…" autocomplete="off">
      <label class="check"><input type="checkbox" id="showInherited" ${ui.inherited ? "checked" : ""}> Include inherited</label>
      <span class="muted" style="font-size:12px">Click a row to copy the attribute name</span>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Long</th><th>Short</th><th>Nice name</th><th>Type</th></tr></thead>
      <tbody id="attrRows"></tbody>
    </table></div>`);

  const draw = () => {
    const q = ui.filter.toLowerCase();
    const groups = [[name, declared]];
    if (ui.inherited) for (const anc of [...inherits].reverse()) if (nodes[anc]) groups.push([anc, nodes[anc][3]]);
    let html = "";
    let total = 0;
    for (const [owner, attrs] of groups) {
      const rows = attrs.filter((a) => !q || a[0].toLowerCase().includes(q) || (a[1] || "").toLowerCase().includes(q) || (a[2] || "").toLowerCase().includes(q));
      if (!rows.length) continue;
      total += rows.length;
      if (ui.inherited) html += `<tr class="group-row"><td colspan="4">${owner === name ? "declared on " : "from "}<a href="#/n/${enc(owner)}">${esc(owner)}</a> · ${rows.length}</td></tr>`;
      html += rows
        .map((a) => `<tr class="clickable" data-attr="${esc(a[0])}"><td class="mono">${esc(a[0])}</td><td class="mono muted">${esc(a[1])}</td><td>${esc(a[2])}</td><td><span class="type">${esc(a[3])}</span></td></tr>`)
        .join("");
    }
    $("#attrRows").innerHTML = total ? html : `<tr><td colspan="4" class="empty">No attributes match</td></tr>`;
  };
  draw();
  $("#attrFilter").addEventListener("input", (ev) => { ui.filter = ev.target.value; draw(); });
  $("#showInherited").addEventListener("change", (ev) => { ui.inherited = ev.target.checked; storage("inherited", ui.inherited ? "1" : "0"); draw(); });
  $("#attrRows").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-attr]");
    if (tr && !ev.target.closest("a")) copy(tr.dataset.attr);
  });
}

/* ---------- routing ---------- */

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const [kind, name, member] = parts;
  try {
    if (kind === "c" && name) await renderCommand(name);
    else if (kind === "r" && name) await renderRuntime(name);
    else if (kind === "o" && name) await renderClass(name, member);
    else if (kind === "n" && name) await renderNode(name);
    else if (kind === "list" && KINDS[name]) {
      state.kind = name;
      clearSearch();
      renderHome();
    } else renderHome();
  } catch (err) {
    page(`<h1>Something went wrong</h1><pre class="docpre">${esc(err.message)}</pre>`);
  }
  buildToc();
  if (!state.query && KINDS[kind] && BROWSE_KINDS.includes(kind)) state.kind = kind;
  refreshSidebar();
  if (!state.query) {
    const sel = $("#list li.sel");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
}

function clearSearch() {
  $("#q").value = "";
  state.query = "";
  state.results = [];
  state.sel = -1;
}

/* ---------- boot ---------- */

async function loadVersion(id) {
  state.version = id;
  storage("version", id);
  const [meta, rows] = await Promise.all([fetchJSON(`data/${id}/meta.json`), fetchJSON(`data/${id}/index.json`)]);
  state.meta = meta;
  state.index = prepareIndex(rows);
  if (state.query) state.results = search(state.query);
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

async function boot() {
  applyTheme(storage("theme"));
  $("#theme").addEventListener("click", () => {
    const dark = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#111214";
    const next = dark ? "light" : "dark";
    applyTheme(next);
    storage("theme", next);
  });

  try {
    state.versions = await fetchJSON("data/versions.json");
  } catch (err) {
    page(`<h1>No data</h1><p class="lead">Run the extractor and <code>python3 site/build.py</code>, then serve <code>site/public</code> over HTTP.</p><pre class="docpre">${esc(err.message)}</pre>`);
    return;
  }
  const saved = storage("version");
  const initial = state.versions.some((v) => v.id === saved) ? saved : state.versions[0].id;
  $("#version").innerHTML = state.versions.map((v) => `<option value="${v.id}">Maya ${v.id.slice(0, 4)} (${esc(v.label)})</option>`).join("");
  $("#version").value = initial;
  await loadVersion(initial);

  $("#version").addEventListener("change", async (ev) => {
    await loadVersion(ev.target.value);
    route();
  });

  const q = $("#q");
  let timer;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = q.value;
      state.results = search(q.value);
      state.searchKind = "all";
      state.sel = state.results.length ? 0 : -1;
      refreshSidebar();
      $("#list").scrollTop = 0;
    }, 60);
  });
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); moveSelection(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSelection(-1); }
    else if (ev.key === "Enter") {
      const e = (state.visible || [])[Math.max(state.sel, 0)];
      if (e) location.hash = hrefFor(e);
    } else if (ev.key === "Escape") {
      clearSearch();
      refreshSidebar();
      q.blur();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      q.focus();
      q.select();
    }
  });

  $("#kinds").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (state.query) {
      state.searchKind = b.dataset.kind;
      state.sel = 0;
    } else state.kind = b.dataset.kind;
    refreshSidebar();
    $("#list").scrollTop = 0;
  });

  document.addEventListener("click", (ev) => {
    const jump = ev.target.closest("[data-jump]");
    if (jump) {
      ev.preventDefault();
      const target = document.getElementById(jump.dataset.jump);
      if (target) target.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const b = ev.target.closest("[data-copy]");
    if (b) copy(b.dataset.copy);
  });

  let tocFrame = 0;
  $("#main").addEventListener("scroll", () => {
    cancelAnimationFrame(tocFrame);
    tocFrame = requestAnimationFrame(updateTocActive);
  });

  window.addEventListener("hashchange", route);
  route();
}

boot();
