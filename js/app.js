import { decryptTimeline } from "./crypto.js";
import {
  allView,
  dayView,
  escapeHtml,
  formatKoreanDate,
  sizedInfoHtml,
  infoModel,
  newestDate,
  normalize,
  shortDate,
} from "./timeline.js";

const STORAGE_KEY = "delivery-timeline.v1.password";
const STOP_ZOOM = 17;

const state = {
  payload: null,
  timeline: null,
  view: null,
  mode: "day",
  date: null,
  night: true,
  day: true,
  showPath: false,
  selectedId: null,
};

const $ = (id) => document.getElementById(id);

const lockScreen = $("lock-screen");
const lockForm = $("lock-form");
const passwordInput = $("password");
const rememberBox = $("remember");
const lockError = $("lock-error");
const unlockButton = $("unlock");
const app = $("app");
const datesEl = $("dates");
const listEl = $("list");
const summaryEl = $("summary");
const listPane = $("list-pane");
const mapPane = $("map-pane");
const mapEl = $("map");
const schemaEl = $("schema");
const mapNote = $("map-note");
const schemaInfo = $("schema-info");

let picked = false;

function readSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch (err) {
    return "";
  }
}

function writeSaved(password) {
  try {
    if (password) localStorage.setItem(STORAGE_KEY, password);
    else localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    // Private mode can reject storage. The unlock still works for this tab.
  }
}

function showError(message) {
  lockError.textContent = message || "";
}

function messageFor(err) {
  const name = err && err.name;
  if (name === "OperationError" || name === "InvalidAccessError") {
    return "비밀번호가 맞지 않습니다.";
  }
  return "기록을 열지 못했습니다.";
}

function clientId() {
  const id = String(window.NAVER_CLIENT_ID || "").trim();
  if (!id || id.startsWith("YOUR_")) return "";
  return id;
}

function filters() {
  return { night: state.night, day: state.day };
}

function currentView() {
  if (!state.timeline) return null;
  if (state.mode === "all") return allView(state.timeline, filters());
  return dayView(state.timeline, state.date, filters());
}

function findStop(id) {
  if (!state.view) return null;
  return state.view.stops.find((stop) => stop.id === id) || null;
}

function buttonById(root, id) {
  for (const button of root.querySelectorAll("[data-id]")) {
    if (button.dataset.id === id) return button;
  }
  return null;
}

function markSelected() {
  const id = state.selectedId;
  for (const button of listEl.querySelectorAll(".stop-row")) {
    const on = button.dataset.id === id;
    button.classList.toggle("is-selected", on);
    if (on) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  for (const button of mapPane.querySelectorAll(".dot-btn")) {
    button.classList.toggle("is-selected", button.dataset.id === id);
  }
}

function clearSelection() {
  state.selectedId = null;
  markSelected();
  mapCtl.closeInfo();
}

function selectStop(id, { zoom }) {
  const stop = findStop(id);
  if (!stop) return;
  picked = true;
  setTimeout(() => {
    picked = false;
  }, 0);
  state.selectedId = id;
  markSelected();
  mapCtl.open(stop, { zoom });
  if (!zoom) {
    const row = buttonById(listEl, id);
    if (row) row.scrollIntoView({ block: "nearest" });
  }
}

function renderDates() {
  const dates = state.timeline.days.map((day) => day.date).slice().sort().reverse();
  datesEl.replaceChildren();
  datesEl.append(dateButton({ all: true, label: "전체 기간", selected: state.mode === "all" }));
  for (const date of dates) {
    datesEl.append(dateButton({
      all: false,
      date,
      label: shortDate(date),
      selected: state.mode === "day" && state.date === date,
    }));
  }
}

function dateButton({ all, date, label, selected }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "date-btn";
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", selected ? "true" : "false");
  button.textContent = label;
  button.addEventListener("click", () => {
    state.mode = all ? "all" : "day";
    if (!all) state.date = date;
    state.selectedId = null;
    render({ fit: true, scrollList: true });
  });
  return button;
}

function syncToggles() {
  $("toggle-night").setAttribute("aria-pressed", state.night ? "true" : "false");
  $("toggle-day").setAttribute("aria-pressed", state.day ? "true" : "false");
  $("toggle-path").setAttribute("aria-pressed", state.showPath ? "true" : "false");
}

function filtersLabel() {
  return state.mode === "all" ? "전체 기간" : shortDate(state.date);
}

function syncFiltersButton() {
  const button = $("filters-btn");
  const label = $("filters-label");
  const text = filtersLabel();
  if (label) label.textContent = text;
  else button.textContent = text;
  button.setAttribute("aria-expanded", $("controls").hidden ? "false" : "true");
}

function refreshMapSize() {
  requestAnimationFrame(() => {
    mapCtl.resize();
    requestAnimationFrame(() => mapCtl.resize());
  });
}

function toggleFilters() {
  const panel = $("controls");
  const open = panel.hidden;
  panel.hidden = !open;
  $("filters-btn").setAttribute("aria-expanded", open ? "true" : "false");
  refreshMapSize();
}

function summaryText(view) {
  if (view.mode === "all") {
    return `전체 기간 · ${view.rows.length}곳 · 방문 ${view.stops.length}회`;
  }
  return `${formatKoreanDate(state.date)} · ${view.stops.length}곳`;
}

function renderList(view) {
  summaryEl.textContent = summaryText(view);
  listEl.replaceChildren();
  if (view.mode === "day") {
    if (!view.groups.length) {
      listEl.append(emptyNote("표시할 배달이 없습니다."));
      return;
    }
    const rowById = new Map(view.rows.map((row) => [row.id, row]));
    for (const group of view.groups) {
      const heading = document.createElement("h2");
      heading.className = "group-h";
      heading.dataset.kind = group.kind;
      const sq = document.createElement("span");
      sq.className = "sq";
      const label = document.createElement("span");
      label.textContent = group.label;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${group.stops.length}곳`;
      heading.append(sq, label, count);
      listEl.append(heading);
      for (const stop of group.stops) listEl.append(stopButton(rowById.get(stop.id)));
    }
    return;
  }
  if (!view.rows.length) {
    listEl.append(emptyNote("표시할 배달이 없습니다."));
    return;
  }
  for (const row of view.rows) listEl.append(stopButton(row));
}

function emptyNote(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

function stopButton(row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stop-row";
  button.dataset.id = row.id;
  button.dataset.kind = row.kind;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = row.timeText;
  const body = document.createElement("span");
  body.className = "body";
  const line = document.createElement("span");
  line.className = "addr";
  const primary = document.createElement("span");
  primary.className = "road";
  primary.textContent = row.primary;
  line.append(primary);
  if (row.secondary) {
    const secondary = document.createElement("span");
    secondary.className = "jibun";
    secondary.textContent = row.secondary;
    line.append(secondary);
  }
  body.append(line);
  if (row.name || row.meta) {
    const extra = document.createElement("span");
    extra.className = "name";
    extra.textContent = [row.name, row.meta].filter(Boolean).join(" · ");
    body.append(extra);
  }
  button.append(time, body);
  const label = [row.timeText, row.primary, row.secondary, row.name].filter(Boolean).join(", ");
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => selectStop(row.id, { zoom: true }));
  return button;
}

function render({ fit = false, scrollList = false } = {}) {
  state.view = currentView();
  if (!state.view) return;
  renderDates();
  syncToggles();
  syncFiltersButton();
  renderList(state.view);
  if (scrollList) listPane.scrollTop = 0;
  if (state.selectedId && !findStop(state.selectedId)) {
    state.selectedId = null;
    mapCtl.closeInfo();
  }
  markSelected();
  mapCtl.sync(state.view, { fit });
}

const mapCtl = {
  backend: null,
  map: null,
  info: null,
  markers: [],
  lines: [],
  sig: "",
  authFailed: false,
  note: "",
  lastW: 0,
  lastH: 0,

  async ensure() {
    if (this.backend) {
      this.resize();
      return;
    }
    const id = clientId();
    if (!id) {
      this.useSchema("Client ID를 넣으면 네이버 지도가 표시됩니다.");
      return;
    }
    try {
      await loadNaver(id, () => {
        this.authFailed = true;
      });
      if (this.authFailed || !window.naver || !window.naver.maps || !window.naver.maps.Map) {
        this.useSchema("네이버 지도 인증에 실패했습니다. Web 서비스 URL을 확인해 주세요.");
        return;
      }
      this.useNaver();
    } catch (err) {
      this.useSchema("네이버 지도를 불러오지 못했습니다.");
    }
  },

  useSchema(note) {
    this.backend = "schema";
    this.note = note;
    this.sig = "";
    schemaEl.hidden = false;
    mapNote.hidden = false;
    mapNote.textContent = note;
    this.watchSize();
  },

  watchSize() {
    if (this.resizeObs) return;
    this.resizeObs = new ResizeObserver(() => {
      const width = mapPane.clientWidth;
      const height = mapPane.clientHeight;
      if (width === this.lastW && height === this.lastH) return;
      this.lastW = width;
      this.lastH = height;
      if (this.backend === "naver") this.resize();
      else if (this.backend === "schema" && state.view) {
        const selected = state.selectedId;
        this.drawSchema(state.view);
        if (selected) {
          const stop = state.view.stops.find((item) => item.id === selected);
          if (stop) this.open(stop, { zoom: false });
        } else this.highlight();
      }
    });
    this.resizeObs.observe(mapPane);
  },

  useNaver() {
    const rect = mapEl.getBoundingClientRect();
    const options = {
      zoom: 16,
      center: new naver.maps.LatLng(37.263, 127.049),
      size: new naver.maps.Size(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height))),
      scaleControl: false,
      mapDataControl: true,
      logoControl: true,
      zoomControl: true,
      zoomControlOptions: {
        position: naver.maps.Position.RIGHT_CENTER,
        style: naver.maps.ZoomControlStyle.SMALL,
      },
    };
    const styleApi = naver.maps.NaverStyleMapTypeOptions;
    if (styleApi && typeof styleApi.getNormalMap === "function") {
      try {
        const typeId = (naver.maps.MapTypeId && naver.maps.MapTypeId.NORMAL) || "normal";
        options.mapTypes = new naver.maps.MapTypeRegistry({
          [typeId]: styleApi.getNormalMap({ overlayType: "bg.ol.ts.ctt.lko" }),
        });
        options.mapTypeId = typeId;
      } catch (err) {
        // Keep the default base map if the style helper is unavailable.
      }
    }
    this.map = new naver.maps.Map(mapEl, options);
    this.info = new naver.maps.InfoWindow({
      content: "",
      borderWidth: 0,
      backgroundColor: "transparent",
      disableAnchor: true,
      pixelOffset: new naver.maps.Point(0, -16),
    });
    naver.maps.Event.addListener(this.map, "click", () => {
      if (picked) return;
      clearSelection();
    });
    this.backend = "naver";
    schemaEl.hidden = true;
    mapNote.hidden = true;
    schemaInfo.hidden = true;
    this.sig = "";
    this.watchSize();
  },

  resize() {
    if (!this.map) return;
    const rect = mapEl.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    if (typeof this.map.autoResize === "function") this.map.autoResize();
    this.map.setSize(new naver.maps.Size(Math.round(rect.width), Math.round(rect.height)));
  },

  signature(view) {
    const ids = view.stops.map((stop) => stop.id).join(",");
    const paths = state.showPath ? view.paths.map((path) => `${path.kind}:${path.path.length}`).join(",") : "";
    return `${ids}#${paths}`;
  },

  sync(view, { fit }) {
    if (!this.backend || !view) return;
    const sig = this.signature(view);
    let redrew = false;
    if (sig !== this.sig) {
      this.sig = sig;
      this.draw(view);
      redrew = true;
      if (fit) this.fit(view);
    } else if (fit) {
      this.fit(view);
      if (this.backend === "schema") redrew = true;
    }
    this.highlight();
    if (redrew && state.selectedId) {
      const stop = view.stops.find((item) => item.id === state.selectedId);
      if (stop) this.open(stop, { zoom: false });
    }
  },

  draw(view) {
    if (this.backend === "naver") this.drawNaver(view);
    else this.drawSchema(view);
  },

  clearNaver() {
    for (const marker of this.markers) marker.setMap(null);
    for (const line of this.lines) line.setMap(null);
    this.markers = [];
    this.lines = [];
  },

  drawNaver(view) {
    this.clearNaver();
    this.closeInfo();
    if (state.showPath) {
      for (const path of view.paths) {
        this.lines.push(new naver.maps.Polyline({
          map: this.map,
          path: path.path.map(([lat, lon]) => new naver.maps.LatLng(lat, lon)),
          strokeColor: path.kind === "야간" ? "#1D4ED8" : "#E86A17",
          strokeOpacity: 0.8,
          strokeWeight: 4,
          strokeLineCap: "round",
          strokeLineJoin: "round",
          zIndex: 1,
          clickable: false,
        }));
      }
    }
    for (const stop of view.stops) {
      const marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(stop.lat, stop.lon),
        map: this.map,
        zIndex: 10,
        icon: dotIcon(stop),
      });
      naver.maps.Event.addListener(marker, "click", () => selectStop(stop.id, { zoom: false }));
      this.markers.push(marker);
    }
  },

  drawSchema(view) {
    schemaEl.replaceChildren();
    schemaInfo.hidden = true;
    const width = Math.max(schemaEl.clientWidth, mapPane.clientWidth, 1);
    const height = Math.max(schemaEl.clientHeight, mapPane.clientHeight, 1);
    if (!view.stops.length) return;
    const points = view.stops.map((stop) => ({ lat: stop.lat, lon: stop.lon }));
    if (state.showPath) {
      for (const path of view.paths) {
        for (const pair of path.path) points.push({ lat: pair[0], lon: pair[1] });
      }
    }
    const proj = project(points, width, height);
    if (state.showPath && view.paths.length) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      for (const path of view.paths) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        line.setAttribute("fill", "none");
        line.setAttribute("stroke", path.kind === "야간" ? "#1D4ED8" : "#E86A17");
        line.setAttribute("stroke-width", "3");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("stroke-linejoin", "round");
        line.setAttribute("opacity", "0.85");
        line.setAttribute("points", path.path.map(([lat, lon]) => {
          const point = proj({ lat, lon });
          return `${point.x},${point.y}`;
        }).join(" "));
        svg.append(line);
      }
      schemaEl.append(svg);
    }
    const placed = separatePoints(view.stops.map((stop) => proj(stop)), 40).map((point) => ({
      x: Math.min(width - 22, Math.max(22, point.x)),
      y: Math.min(height - 22, Math.max(46, point.y)),
    }));
    view.stops.forEach((stop, index) => {
      const model = infoModel(stop);
      const point = placed[index];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dot-btn";
      button.dataset.kind = stop.kind;
      button.dataset.id = stop.id;
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
      button.setAttribute("aria-label", `${model.primary}, ${model.badge}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        selectStop(stop.id, { zoom: false });
      });
      schemaEl.append(button);
    });
  },

  fit(view) {
    if (!view.stops.length) return;
    if (this.backend === "naver") {
      if (view.stops.length === 1) {
        const only = view.stops[0];
        this.map.setCenter(new naver.maps.LatLng(only.lat, only.lon));
        this.map.setZoom(16);
        return;
      }
      const first = new naver.maps.LatLng(view.stops[0].lat, view.stops[0].lon);
      const bounds = new naver.maps.LatLngBounds(first, first);
      for (const stop of view.stops.slice(1)) {
        bounds.extend(new naver.maps.LatLng(stop.lat, stop.lon));
      }
      try {
        this.map.fitBounds(bounds, { top: 48, right: 56, bottom: 36, left: 24 });
      } catch (err) {
        this.map.fitBounds(bounds, 48);
      }
      return;
    }
    this.drawSchema(view);
  },

  highlight() {
    for (const button of mapPane.querySelectorAll(".dot-btn")) {
      const on = button.dataset.id === state.selectedId;
      button.classList.toggle("is-selected", on);
    }
    if (this.backend === "naver") {
      this.markers.forEach((marker, index) => {
        const stop = state.view && state.view.stops[index];
        if (stop && marker.setZIndex) marker.setZIndex(stop.id === state.selectedId ? 20 : 10);
      });
    }
  },

  open(stop, { zoom }) {
    if (this.backend === "naver" && this.map) {
      const position = new naver.maps.LatLng(stop.lat, stop.lon);
      if (zoom) {
        if (typeof this.map.morph === "function") this.map.morph(position, STOP_ZOOM);
        else {
          this.map.setCenter(position);
          this.map.setZoom(STOP_ZOOM);
        }
      }
      const marker = this.markers[state.view.stops.findIndex((item) => item.id === stop.id)] || null;
      this.info.setContent(sizedInfoHtml(stop));
      if (marker) this.info.open(this.map, marker);
      else this.info.open(this.map, position);
      requestAnimationFrame(() => this.restyleInfoChrome());
      this.highlight();
      return;
    }
    schemaInfo.innerHTML = sizedInfoHtml(stop);
    schemaInfo.hidden = false;
    schemaInfo.style.transform = "translate(-50%, calc(-100% - 8px))";
    const button = buttonById(schemaEl, stop.id);
    if (button) {
      schemaInfo.style.left = button.style.left;
      schemaInfo.style.top = button.style.top;
    }
    this.highlight();
    requestAnimationFrame(() => {
      const card = schemaInfo.getBoundingClientRect();
      const pane = mapPane.getBoundingClientRect();
      if (card.top < pane.top + 28) {
        schemaInfo.style.transform = "translate(-50%, 14px)";
      }
    });
  },

  restyleInfoChrome() {
    const card = mapEl.querySelector(".iw") || schemaInfo.querySelector(".iw");
    if (!card) return;
    let node = card.parentElement;
    for (let i = 0; i < 8 && node && node !== mapPane; i += 1) {
      node.style.background = "transparent";
      node.style.backgroundColor = "transparent";
      node.style.border = "0";
      node.style.borderWidth = "0";
      node.style.boxShadow = "none";
      node = node.parentElement;
    }
  },

  closeInfo() {

    if (this.info && this.info.getMap && this.info.getMap()) this.info.close();
    schemaInfo.hidden = true;
    schemaInfo.replaceChildren();
  },

  reset() {
    this.sig = "";
    this.clearNaver();
    this.closeInfo();
    schemaEl.replaceChildren();
  },
};

schemaEl.addEventListener("click", () => {
  if (picked) return;
  clearSelection();
});

function dotIcon(stop) {
  const model = infoModel(stop);
  return {
    content: `<button type="button" class="dot-btn" data-kind="${escapeHtml(stop.kind)}" data-id="${escapeHtml(stop.id)}" aria-label="${escapeHtml(model.primary)}, ${escapeHtml(model.badge)}"></button>`,
    size: new naver.maps.Size(44, 44),
    anchor: new naver.maps.Point(22, 22),
  };
}

function separatePoints(points, gap) {
  const placed = points.map((point) => ({ x: point.x, y: point.y }));
  for (let pass = 0; pass < 12; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        let dx = placed[i].x - placed[j].x;
        let dy = placed[i].y - placed[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        if (dist < gap) {
          const push = (gap - dist) / 2;
          placed[i].x += (dx / dist) * push;
          placed[i].y += (dy / dist) * push;
          placed[j].x -= (dx / dist) * push;
          placed[j].y -= (dy / dist) * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return placed;
}

function project(points, width, height) {
  let minLat = Math.min(...points.map((point) => point.lat));
  let maxLat = Math.max(...points.map((point) => point.lat));
  let minLon = Math.min(...points.map((point) => point.lon));
  let maxLon = Math.max(...points.map((point) => point.lon));
  const latPad = Math.max((maxLat - minLat) * 0.22, 0.0015);
  const lonPad = Math.max((maxLon - minLon) * 0.22, 0.0015);
  minLat -= latPad;
  maxLat += latPad;
  minLon -= lonPad;
  maxLon += lonPad;
  const innerW = Math.max(width - 28, 1);
  const innerH = Math.max(height - 56, 1);
  return (point) => ({
    x: 14 + ((point.lon - minLon) / (maxLon - minLon)) * innerW,
    y: 40 + ((maxLat - point.lat) / (maxLat - minLat)) * innerH,
  });
}

function loadNaver(id, onAuthFailure) {
  window.navermap_authFailure = onAuthFailure;
  return new Promise((resolve, reject) => {
    if (window.naver && window.naver.maps && window.naver.maps.Map) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    // Current NCP Maps v3 parameter. Do not switch this back to the old name.
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(id)}`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("map"));
    document.head.appendChild(script);
  });
}

async function loadPayload() {
  const url = new URL("data/timeline.enc.json", document.baseURI);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("fetch");
  return response.json();
}

function showApp() {
  lockScreen.hidden = true;
  app.hidden = false;
}

async function unlock(password, remember) {
  const raw = await decryptTimeline(state.payload, password);
  const timeline = normalize(raw);
  if (!timeline.days.length) throw new Error("empty");
  state.timeline = timeline;
  state.date = newestDate(timeline);
  state.mode = "day";
  state.night = true;
  state.day = true;
  state.showPath = false;
  state.selectedId = null;
  writeSaved(remember ? password : "");
  passwordInput.value = "";
  showError("");
  showApp();
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  render({ fit: true, scrollList: true });
  await mapCtl.ensure();
  mapCtl.sync(state.view, { fit: true });
}

function lock() {
  state.timeline = null;
  state.view = null;
  state.selectedId = null;
  state.date = null;
  writeSaved("");
  rememberBox.checked = false;
  passwordInput.value = "";
  showError("");
  listEl.replaceChildren();
  summaryEl.textContent = "";
  datesEl.replaceChildren();
  mapCtl.reset();
  app.hidden = true;
  lockScreen.hidden = false;
  passwordInput.focus();
}

function bind() {
  lockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = passwordInput.value;
    if (!password) {
      showError("비밀번호를 입력하세요.");
      return;
    }
    unlockButton.disabled = true;
    unlockButton.textContent = "여는 중…";
    try {
      await unlock(password, rememberBox.checked);
    } catch (err) {
      showError(messageFor(err));
    } finally {
      unlockButton.disabled = false;
      unlockButton.textContent = "열기";
    }
  });
  $("lock-btn").addEventListener("click", lock);
  $("filters-btn").addEventListener("click", toggleFilters);
  $("toggle-night").addEventListener("click", () => {
    state.night = !state.night;
    state.selectedId = null;
    render({ fit: true, scrollList: true });
  });
  $("toggle-day").addEventListener("click", () => {
    state.day = !state.day;
    state.selectedId = null;
    render({ fit: true, scrollList: true });
  });
  $("toggle-path").addEventListener("click", () => {
    state.showPath = !state.showPath;
    render({ fit: false });
  });
}

async function boot() {
  bind();
  try {
    state.payload = await loadPayload();
  } catch (err) {
    showError("기록을 불러오지 못했습니다.");
    document.documentElement.classList.remove("booting");
    return;
  }
  const saved = readSaved();
  if (!saved) {
    document.documentElement.classList.remove("booting");
    passwordInput.focus();
    return;
  }
  try {
    await unlock(saved, true);
  } catch (err) {
    writeSaved("");
    showError("저장된 비밀번호로 열지 못했습니다.");
  } finally {
    document.documentElement.classList.remove("booting");
  }
}

boot();
