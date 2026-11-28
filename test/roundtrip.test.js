import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { b64ToBytes, decryptBytes, decryptTimeline } from "../js/crypto.js";
import {
  allView,
  dayView,
  formatKoreanDate,
  infoHtml,
  infoModel,
  stripRegion,
  mergeStops,
  newestDate,
  normalize,
} from "../js/timeline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "test/fixtures/sample.plain.json");
const encPath = path.join(root, "data/timeline.enc.json");

function runEncrypt(plainPath, password, extraArgs = []) {
  const env = { ...process.env };
  if (password == null) delete env.TIMELINE_PASSWORD;
  else env.TIMELINE_PASSWORD = password;
  return spawnSync("python3", ["tools/encrypt.py", plainPath, ...extraArgs], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("pages shell stays free of secrets and uses the current map parameter", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const app = await readFile(path.join(root, "js/app.js"), "utf8");
  const config = await readFile(path.join(root, "config.js"), "utf8");
  const tool = await readFile(path.join(root, "tools/encrypt.py"), "utf8");
  assert.match(html, /name="robots" content="noindex"/);
  assert.match(app, /ncpKeyId=/);
  assert.doesNotMatch(app, /ncpClientId/);
  assert.match(config, /window\.NAVER_CLIENT_ID = "[^"]+";/);
  assert.doesNotMatch(config, /CLIENT_SECRET|client_secret/);
  assert.match(tool, /TIMELINE_PASSWORD/);
  assert.doesNotMatch(tool, /print\(.*password/i);
  assert.doesNotMatch(tool, /sys\.argv\[2\]/);
});

describe("encrypted file", { concurrency: 1 }, () => {
test("sample ciphertext decrypts with sample and matches the fixture", async () => {
  const fixture = await readFile(fixturePath);
  const payload = JSON.parse(await readFile(encPath, "utf8"));
  assert.equal(payload.v, 1);
  assert.equal(payload.kdf, "PBKDF2-SHA256");
  assert.ok(payload.iter >= 200000);
  assert.equal(b64ToBytes(payload.salt).byteLength, 16);
  assert.equal(b64ToBytes(payload.iv).byteLength, 12);
  const raw = await readFile(encPath, "utf8");
  assert.equal(/[가-힣]/.test(raw), false);
  const sampleOpens = await decryptBytes(payload, "sample").then(
    () => true,
    (err) => {
      assert.equal(err.name, "OperationError");
      return false;
    }
  );
  if (!sampleOpens) return; // real data is deployed; only the sample is checkable here
  const bytes = await decryptBytes(payload, "sample");
  assert.equal(Buffer.from(bytes).equals(fixture), true);
  const data = await decryptTimeline(payload, "sample");
  const timeline = normalize(data);
  assert.deepEqual(
    timeline.days.map((day) => day.date),
    ["2026-11-25", "2026-11-26", "2026-11-27"]
  );
  assert.equal(newestDate(timeline), "2026-11-27");
  assert.equal(formatKoreanDate("2026-11-27"), "2026년 11월 27일 (금)");
  await assert.rejects(
    () => decryptTimeline(payload, "sample-wrong"),
    (err) => err.name === "OperationError"
  );
});

test("day and all-period views", async () => {
  const timeline = normalize(JSON.parse(await readFile(fixturePath, "utf8")));
  const both = { night: true, day: true };
  const day = dayView(timeline, "2026-11-27", both);
  assert.equal(day.stops.length, 8);
  assert.equal(day.groups[0].label, "야간 (새벽)");
  assert.equal(day.groups[0].stops[0].t, "03:12");
  assert.equal(day.groups[1].label, "주간 (저녁)");
  assert.equal(day.paths.length, 2);
  assert.deepEqual(
    day.stops.map((stop) => stop.t),
    day.stops.map((stop) => stop.t).slice().sort()
  );

  const nightOnly = dayView(timeline, "2026-11-27", { night: true, day: false });
  assert.equal(nightOnly.stops.length, 4);
  assert.ok(nightOnly.stops.every((stop) => stop.kind === "야간"));
  assert.equal(nightOnly.paths.length, 1);

  const blank = nightOnly.stops.find((stop) => stop.road === "");
  const model = infoModel(blank);
  assert.deepEqual(Object.keys(model).sort(), ["badge", "primary", "secondary"]);
  assert.equal(model.badge, "야간");
  assert.equal(model.primary, "별리지 9-3");
  assert.equal(model.secondary, "");
  const html = infoHtml(blank);
  assert.equal(html.includes(blank.t), false);
  assert.equal(html.includes("가상대지"), false);
  assert.match(html, /별리지 9-3/);
  assert.equal(html.includes("야간"), false);
  assert.equal(html.includes("iw-badge"), false);
  const hostile = infoHtml({ ...blank, road: `<img alt="">`, jibun: `a"b` });
  assert.equal(hostile.includes("<img"), false);
  assert.match(hostile, /&lt;img/);

  const all = allView(timeline, both);
  assert.equal(all.stops.length, 22);
  assert.equal(all.rows.length, 8);
  const apt = all.rows.find((row) => row.name === "샘플아파트");
  assert.equal(apt.count, 6);
  assert.equal(apt.timeText, "6회");
  assert.equal(apt.meta, "3일");
  const road = all.rows.find((row) => row.primary === "연습길 21" && !row.name);
  assert.equal(road.count, 3);
  const solo = all.rows.find((row) => row.primary === "가상리 55-1");
  assert.equal(solo.count, 1);
  assert.equal(solo.timeText, "04:15");

  const dayOnly = allView(timeline, { night: false, day: true });
  assert.ok(dayOnly.stops.every((stop) => stop.kind === "주간"));
  assert.equal(dayOnly.rows.some((row) => row.name === "가상대지"), false);
});

test("post-midnight evening stops sort after that evening", () => {
  const timeline = normalize({
    days: [{
      date: "2026-11-23",
      shifts: [
        { kind: "주간", label: "주간 (저녁)", stops: [
          { t: "00:05", lat: 37.2, lon: 127.0, road: "A", jibun: "1" },
          { t: "23:50", lat: 37.2, lon: 127.0, road: "B", jibun: "2" },
          { t: "19:10", lat: 37.2, lon: 127.0, road: "C", jibun: "3" },
        ] },
        { kind: "야간", label: "야간 (새벽)", stops: [
          { t: "02:10", lat: 37.2, lon: 127.0, road: "D", jibun: "4" },
        ] },
      ],
    }],
  });
  const both = { night: true, day: true };
  const view = dayView(timeline, "2026-11-23", both);
  assert.deepEqual(view.stops.map((stop) => stop.t), ["02:10", "19:10", "23:50", "00:05"]);
  assert.equal(view.groups[0].kind, "야간");
});

test("stripRegion drops 영통구 prefixes and the info window has a width", () => {
  assert.equal(stripRegion("영통구 광교호수공원로 20"), "광교호수공원로 20");
  assert.equal(stripRegion("수원시 영통구 매탄동 176"), "매탄동 176");
  assert.equal(stripRegion("경기도 수원시 영통구 덕영대로 1"), "덕영대로 1");
  assert.equal(stripRegion("경기 수원시 영통구 원천동 1"), "원천동 1");
  assert.equal(stripRegion("덕영대로 1"), "덕영대로 1");
  const html = infoHtml({
    t: "03:00",
    lat: 37.2,
    lon: 127.0,
    road: "영통구 광교호수공원로 20",
    jibun: "수원시 영통구 하동 10",
    kind: "야간",
  });
  assert.equal(html.includes("영통구"), false);
  assert.match(html, /광교호수공원로 20/);
  assert.match(html, /하동 10/);
  assert.match(html, /min-width:\s*90px/);
  assert.match(html, /max-width:\s*240px/);
  assert.match(html, /width:\s*max-content/);
  assert.match(html, /word-break:\s*keep-all/);
  assert.equal(html.includes("iw-badge"), false);
  assert.equal(html.includes("야간"), false);
  const short = infoHtml({
    t: "03:00",
    lat: 37.2,
    lon: 127.0,
    road: "",
    jibun: "매탄동 362-1",
    kind: "주간",
  }, { width: 118 });
  assert.match(short, /width:\s*118px/);
  assert.equal(/white-space:\s*nowrap/.test(short), true);
  const long = infoHtml({
    t: "03:00",
    lat: 37.2,
    lon: 127.0,
    road: "광교호수공원로 155번길 37-12",
    jibun: "원천동 548-19",
    kind: "야간",
  }, { width: 240, wrap: true });
  assert.match(long, /width:\s*240px/);
  assert.match(long, /iw-wrap/);
  assert.match(long, /white-space:\s*normal/);
});

test("same name or same road merges, blank fields do not", () => {
  const rows = mergeStops([
    { id: "a", name: "X", road: "R1", jibun: "1", kind: "야간", date: "2026-11-25", t: "01:00", lat: 1, lon: 1 },
    { id: "b", name: "X", road: "R2", jibun: "2", kind: "야간", date: "2026-11-25", t: "02:00", lat: 1, lon: 1 },
    { id: "c", name: "", road: "R2", jibun: "3", kind: "주간", date: "2026-11-26", t: "18:00", lat: 1, lon: 1 },
    { id: "d", name: "", road: "R3", jibun: "4", kind: "주간", date: "2026-11-26", t: "19:00", lat: 1, lon: 1 },
    { id: "e", name: "", road: "", jibun: "같은지번", kind: "야간", date: "2026-11-27", t: "03:00", lat: 1, lon: 1 },
    { id: "f", name: "", road: "", jibun: "같은지번", kind: "야간", date: "2026-11-27", t: "04:00", lat: 1, lon: 1 },
  ]);
  assert.equal(rows.length, 4);
  const linked = rows.find((row) => row.count === 3);
  assert.equal(linked.name, "X");
  assert.equal(linked.kind, "both");
  assert.equal(rows.filter((row) => row.count === 1).length, 3);
});

test("python encrypt round-trips through the browser decrypt", async () => {
  const backup = await readFile(encPath);
  const fixture = await readFile(fixturePath);
  const dir = await mkdtemp(path.join(tmpdir(), "timeline-"));
  const badPath = path.join(dir, "bad.json");
  await writeFile(badPath, "{}\n");
  try {
    const missing = runEncrypt(fixturePath, null);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /TIMELINE_PASSWORD is not set/);

    const decoy = "do-not-print-this-secret";
    const leaked = runEncrypt(fixturePath, "", [decoy]);
    assert.notEqual(leaked.status, 0);
    assert.equal(`${leaked.stdout}${leaked.stderr}`.includes(decoy), false);

    const invalid = runEncrypt(badPath, "sample");
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid plaintext/);

    const korean = "라운드트립-비밀번호-9f3a";
    const again = runEncrypt(fixturePath, korean);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /wrote data\/timeline\.enc\.json \(3 days\)/);
    const encoded = JSON.parse(await readFile(encPath, "utf8"));
    assert.ok(encoded.iter >= 200000);
    assert.equal((await readFile(encPath, "utf8")).includes(korean), false);
    const opened = await decryptBytes(encoded, korean);
    assert.equal(Buffer.from(opened).equals(fixture), true);
    await assert.rejects(
      () => decryptBytes(encoded, "sample"),
      (err) => err.name === "OperationError"
    );

    const restored = runEncrypt(fixturePath, "sample");
    assert.equal(restored.status, 0, restored.stderr);
    const samplePayload = JSON.parse(await readFile(encPath, "utf8"));
    const sampleBytes = await decryptBytes(samplePayload, "sample");
    assert.equal(Buffer.from(sampleBytes).equals(fixture), true);
  } finally {
    await writeFile(encPath, backup);
  }
});
});
