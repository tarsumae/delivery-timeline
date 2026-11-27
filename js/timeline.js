// Plain timeline helpers shared by the page and the Node tests.
// A merged row joins stops that share a non-empty complex name or the same
// non-empty road address. The link is transitive. Blank names and blank
// roads do not glue unrelated stops together.

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function asString(value) {
  return value == null ? "" : String(value);
}

function stamp(stop) {
  return `${stop.date}T${stop.t}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

export function normalize(data) {
  const days = (data.days || []).map((day) => ({
    date: day.date,
    shifts: (day.shifts || []).map((shift) => ({
      kind: shift.kind,
      label: shift.label,
      path: Array.isArray(shift.path)
        ? shift.path.map((pair) => [Number(pair[0]), Number(pair[1])])
        : null,
      stops: (shift.stops || []).map((stop, index) => ({
        t: String(stop.t),
        lat: Number(stop.lat),
        lon: Number(stop.lon),
        road: asString(stop.road),
        jibun: asString(stop.jibun),
        name: asString(stop.name),
        date: day.date,
        kind: shift.kind,
        label: shift.label,
        id: `${day.date}|${shift.kind}|${index}|${stop.t}`,
      })),
    })),
  }));
  return { days };
}

export function datesOf(timeline) {
  return timeline.days.map((day) => day.date).slice().sort();
}

export function newestDate(timeline) {
  const dates = datesOf(timeline);
  return dates.length ? dates[dates.length - 1] : null;
}

export function weekday(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function shortDate(iso) {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)} ${weekday(iso)}`;
}

export function formatKoreanDate(iso) {
  const [year, month, day] = iso.split("-");
  return `${year}년 ${Number(month)}월 ${Number(day)}일 (${weekday(iso)})`;
}

function kindOn(kind, filters) {
  if (kind === "야간") return !!filters.night;
  if (kind === "주간") return !!filters.day;
  return false;
}

function addressParts(stop) {
  const road = stop.road.trim();
  const jibun = stop.jibun.trim();
  return {
    primary: road || jibun,
    secondary: road ? jibun : "",
  };
}

export function infoModel(stop) {
  const parts = addressParts(stop);
  return {
    badge: stop.kind === "야간" ? "야간" : "주간",
    primary: parts.primary,
    secondary: parts.secondary,
  };
}

export function infoHtml(stop) {
  const model = infoModel(stop);
  const tone = model.badge === "야간" ? "night" : "day";
  const secondary = model.secondary
    ? `<p class="iw-sub">${escapeHtml(model.secondary)}</p>`
    : "";
  return (
    `<div class="iw">` +
    `<p class="iw-badge ${tone}">${escapeHtml(model.badge)}</p>` +
    `<p class="iw-main">${escapeHtml(model.primary)}</p>` +
    secondary +
    `</div>`
  );
}

export function dayRowModel(stop) {
  const parts = addressParts(stop);
  return {
    id: stop.id,
    kind: stop.kind,
    timeText: stop.t,
    primary: parts.primary,
    secondary: parts.secondary,
    name: stop.name.trim(),
    meta: "",
    stop,
  };
}

function unique(values) {
  const out = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

export function mergeStops(stops) {
  const parent = stops.map((_, index) => index);
  function find(index) {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  }
  function union(a, b) {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pb] = pa;
  }
  const byName = new Map();
  const byRoad = new Map();
  stops.forEach((stop, index) => {
    const name = stop.name.trim();
    const road = stop.road.trim();
    if (name) {
      if (byName.has(name)) union(index, byName.get(name));
      else byName.set(name, index);
    }
    if (road) {
      if (byRoad.has(road)) union(index, byRoad.get(road));
      else byRoad.set(road, index);
    }
  });
  const groups = new Map();
  stops.forEach((stop, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(stop);
  });
  const rows = [];
  for (const members of groups.values()) {
    const ordered = members.slice().sort((a, b) => stamp(a).localeCompare(stamp(b)));
    const latest = ordered[ordered.length - 1];
    const parts = addressParts(latest);
    const names = unique(ordered.map((stop) => stop.name.trim()));
    const kinds = unique(ordered.map((stop) => stop.kind));
    const days = unique(ordered.map((stop) => stop.date)).length;
    const count = ordered.length;
    rows.push({
      id: latest.id,
      kind: kinds.length === 1 ? kinds[0] : "both",
      timeText: count === 1 ? latest.t : `${count}회`,
      primary: parts.primary,
      secondary: parts.secondary,
      name: names.join(" · "),
      meta: count === 1 ? shortDate(latest.date) : `${days}일`,
      stop: latest,
      count,
      days,
      kinds,
    });
  }
  rows.sort((a, b) => stamp(b.stop).localeCompare(stamp(a.stop)));
  return rows;
}

function usablePath(shift) {
  return Array.isArray(shift.path) && shift.path.length >= 2
    ? { kind: shift.kind, path: shift.path }
    : null;
}

export function dayView(timeline, date, filters) {
  const day = timeline.days.find((item) => item.date === date);
  const groups = [];
  const paths = [];
  if (day) {
    for (const shift of day.shifts) {
      if (!kindOn(shift.kind, filters)) continue;
      const stops = shift.stops.slice().sort((a, b) => a.t.localeCompare(b.t));
      if (!stops.length) continue;
      groups.push({
        kind: shift.kind,
        label: shift.label,
        stops,
      });
      const path = usablePath(shift);
      if (path) paths.push(path);
    }
  }
  groups.sort((a, b) => a.stops[0].t.localeCompare(b.stops[0].t));
  return {
    mode: "day",
    date,
    groups,
    stops: groups.flatMap((group) => group.stops),
    paths,
    rows: groups.flatMap((group) => group.stops.map(dayRowModel)),
  };
}

export function allView(timeline, filters) {
  const stops = [];
  const paths = [];
  for (const day of timeline.days) {
    for (const shift of day.shifts) {
      if (!kindOn(shift.kind, filters)) continue;
      stops.push(...shift.stops);
      const path = usablePath(shift);
      if (path) paths.push(path);
    }
  }
  stops.sort((a, b) => stamp(a).localeCompare(stamp(b)));
  return {
    mode: "all",
    stops,
    paths,
    rows: mergeStops(stops),
    groups: [],
  };
}
