// Pure logic for io.github.davidsmorais.framewarchy: parsing sensor files, the helper's state
// file, and the numbers shown in the bar. No QML imports, so the test
// suite runs this file under node unchanged.

// discover-fan output ("fan=..."/"temp=..." lines) into one object.
// Missing lines become empty strings, so a missing sensor is not an error.
function parseDiscovery(text) {
  var out = { fanPath: "", tempPath: "", batPath: "" }
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf("fan=") === 0) out.fanPath = line.slice(4)
    else if (line.indexOf("temp=") === 0) out.tempPath = line.slice(5)
    else if (line.indexOf("bat=") === 0) out.batPath = line.slice(4)
  }
  return out
}

// The helper's state.json plus the current boot id. A state file from an
// earlier boot describes a duty the EC has forgotten: report automatic.
function parseState(text, bootId) {
  var out = { mode: "auto", dutyPercent: 0, curve: "stock" }
  try {
    var state = JSON.parse(String(text))
    if (state.bootId && bootId && String(state.bootId) !== String(bootId).trim()) return out
    if (state.mode === "manual") {
      out.mode = "manual"
      var duty = Number(state.dutyPercent)
      out.dutyPercent = isFinite(duty) ? clampDuty(duty, 0) : 0
    }
    if (state.curve === "quiet" || state.curve === "silent") out.curve = state.curve
  } catch (e) { /* unreadable state means automatic */ }
  return out
}

// The helper's `curves` JSON: which preset the EC is actually running.
// "custom" means thresholds that match no preset; "unknown" means the
// read failed and the caller should keep whatever it already shows.
function parseCurves(text) {
  try {
    var curve = String(JSON.parse(String(text)).curve)
    if (curve === "stock" || curve === "quiet" || curve === "silent" || curve === "custom") return curve
  } catch (e) {}
  return "unknown"
}

// "/sys/.../fan1_input" holds a bare integer RPM; anything else is 0.
function parseRpm(text) {
  var n = parseInt(String(text).trim(), 10)
  return isFinite(n) && n >= 0 ? n : 0
}

// hwmon temps are millidegrees Celsius.
function parseTempC(text) {
  var n = parseInt(String(text).trim(), 10)
  return isFinite(n) ? Math.round(n / 1000) : -1
}

// Snap to the whitelist's step-10 grid, clamped to the 10..100 range the
// sudoers rule permits. A NaN falls back to the given default.
function clampDuty(value, fallback) {
  var n = Math.round(Number(value) / 10) * 10
  if (!isFinite(n)) n = Math.round(Number(fallback) / 10) * 10
  if (!isFinite(n)) n = 50
  return Math.max(10, Math.min(100, n))
}

// "6105" -> "6.1k", "740" -> "740", anything at or below zero -> "off".
// Numbers only, so the result is safe to hand to a plain-text label.
function compactRpm(rpm) {
  if (!(rpm > 0)) return "off"
  if (rpm >= 1000) return (Math.round(rpm / 100) / 10).toFixed(1) + "k"
  return String(Math.round(rpm))
}

// The fan's ceiling, measured at duty 100 on a Framework 13 (8402 RPM).
// The percentage shown in automatic mode is RPM against this ceiling; in
// manual mode the commanded duty is exact and used instead.
var FAN_MAX_RPM = 8400

// Fan duty in automatic mode: how fast the fan spins relative to its
// ceiling. Clamped to 0..100; a missing reading is 0.
function fanPercentAuto(rpm, maxRpm) {
  var ceiling = Number(maxRpm)
  if (!isFinite(ceiling) || ceiling <= 0) return 0
  var n = Math.round(Number(rpm) / ceiling * 100)
  if (!isFinite(n) || n < 0) return 0
  return Math.min(100, n)
}

// CPU temperature color bands for the bar: yellow from 75, red from 90.
// An unknown reading keeps its own level so it can stay uncolored.
function heatLevel(tempC) {
  var t = Number(tempC)
  if (!isFinite(t) || t < 0) return "unknown"
  if (t >= 90) return "hot"
  if (t >= 75) return "warm"
  return "calm"
}


function formatTemp(c) {
  return c >= 0 ? c + "°" : "—"
}

// ---- battery ---------------------------------------------------------------

// A power_supply uevent ("KEY=value" lines) into the numbers the widget
// shows. Charge/voltage/current are micro-units. Missing keys give zeros,
// and `present` is false when there is no usable capacity reading.
function parseBattery(text) {
  var kv = {}
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var at = lines[i].indexOf("=")
    if (at > 0) kv[lines[i].slice(0, at)] = lines[i].slice(at + 1).trim()
  }
  function num(key) { var n = Number(kv[key]); return isFinite(n) ? n : 0 }
  var out = { present: false, percent: 0, status: "Unknown", cycles: 0, sizeWh: 0, watts: 0, minutes: -1 }
  if (kv.POWER_SUPPLY_CAPACITY === undefined) return out
  out.present = kv.POWER_SUPPLY_PRESENT !== "0"
  out.percent = Math.max(0, Math.min(100, Math.round(num("POWER_SUPPLY_CAPACITY"))))
  out.status = kv.POWER_SUPPLY_STATUS || "Unknown"
  out.cycles = Math.max(0, Math.round(num("POWER_SUPPLY_CYCLE_COUNT")))
  var volts = num("POWER_SUPPLY_VOLTAGE_NOW") / 1e6
  var full = num("POWER_SUPPLY_CHARGE_FULL") || num("POWER_SUPPLY_CHARGE_FULL_DESIGN")
  var now = num("POWER_SUPPLY_CHARGE_NOW")
  var amps = Math.abs(num("POWER_SUPPLY_CURRENT_NOW")) / 1e6
  if (kv.POWER_SUPPLY_ENERGY_FULL !== undefined || kv.POWER_SUPPLY_POWER_NOW !== undefined) {
    // Energy-based batteries report microwatt-hours and microwatts directly.
    var eFull = num("POWER_SUPPLY_ENERGY_FULL") || num("POWER_SUPPLY_ENERGY_FULL_DESIGN")
    var eNow = num("POWER_SUPPLY_ENERGY_NOW")
    var pNow = Math.abs(num("POWER_SUPPLY_POWER_NOW"))
    out.sizeWh = eFull / 1e6
    out.watts = pNow / 1e6
    if (pNow > 0) {
      if (out.status === "Discharging") out.minutes = eNow / pNow * 60
      else if (out.status === "Charging") out.minutes = Math.max(0, eFull - eNow) / pNow * 60
    }
  } else {
    out.sizeWh = full / 1e6 * (num("POWER_SUPPLY_VOLTAGE_MIN_DESIGN") / 1e6 || volts)
    out.watts = amps * volts
    if (amps > 0) {
      if (out.status === "Discharging") out.minutes = now / 1e6 / amps * 60
      else if (out.status === "Charging") out.minutes = Math.max(0, full - now) / 1e6 / amps * 60
    }
  }
  if (!isFinite(out.minutes) || out.minutes > 99 * 60) out.minutes = -1
  return out
}

// Battery color band: "full" >= 60, "ok" >= 30, "low" >= 15, "critical" below.
// While charging the battery is always "charging".
function batteryLevel(percent, status) {
  if (status === "Charging") return "charging"
  var p = Number(percent)
  if (!isFinite(p)) return "ok"
  if (p >= 60) return "full"
  if (p >= 30) return "ok"
  if (p >= 15) return "low"
  return "critical"
}

// Nerd Font battery glyph for the level, in steps of ten; a bolt while charging.
function batteryIcon(percent, status) {
  if (status === "Charging") return "\u{F0084}"
  var glyphs = ["\u{F008E}", "\u{F007A}", "\u{F007B}", "\u{F007C}", "\u{F007D}",
                "\u{F007E}", "\u{F007F}", "\u{F0080}", "\u{F0081}", "\u{F0082}", "\u{F0079}"]
  var p = Math.max(0, Math.min(100, Number(percent) || 0))
  return glyphs[Math.round(p / 10)]
}

// "1h 05m" / "42m"; negative means unknown.
function formatDuration(minutes) {
  var m = Math.round(Number(minutes))
  if (!isFinite(m) || m < 0) return "—"
  var h = Math.floor(m / 60)
  var r = m % 60
  if (h === 0) return r + "m"
  return h + "h " + (r < 10 ? "0" : "") + r + "m"
}

function formatWatts(w) {
  var n = Number(w)
  return isFinite(n) ? n.toFixed(1) + "W" : "—"
}

// `ps -eo comm=,pcpu=` into the top consumers: CPU summed per command name
// (a browser is many processes), biggest first. The command is the text before
// the last whitespace-separated number, so names containing spaces survive.
function parseConsumers(text, limit) {
  var sums = {}
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = /^\s*(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(lines[i])
    if (!m) continue
    var cpu = Number(m[2])
    if (!(cpu > 0)) continue
    // The sampler itself is not a consumer.
    if (m[1] === "top" || m[1] === "ps") continue
    sums[m[1]] = (sums[m[1]] || 0) + cpu
  }
  var list = []
  for (var name in sums) list.push({ name: name, cpu: Math.round(sums[name] * 10) / 10 })
  list.sort(function (a, b) { return b.cpu - a.cpu })
  return list.slice(0, limit || 5)
}

// `top -b -n 2` output into the same list as parseConsumers, using only the
// last iteration (the first reports averages since each process started).
// Process rows: PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND...
function parseTop(text, limit) {
  var chunks = String(text).split(/^top - /m)
  var last = chunks[chunks.length - 1]
  var rows = []
  var lines = last.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].trim().split(/\s+/)
    if (f.length < 12 || !/^[0-9]+$/.test(f[0])) continue
    rows.push(f.slice(11).join(" ") + " " + f[8].replace(",", "."))
  }
  return parseConsumers(rows.join("\n"), limit)
}

var HISTORY_MAX_MS = 48 * 3600 * 1000

// Append a {t, p} sample (ms, percent) and drop anything older than 48 h.
// Returns a new list; the input is untouched.
function pushHistory(list, t, percent) {
  var out = []
  var src = Array.isArray(list) ? list : []
  for (var i = 0; i < src.length; i++) {
    var s = src[i]
    if (s && isFinite(s.t) && isFinite(s.p) && t - s.t <= HISTORY_MAX_MS && s.t <= t) out.push({ t: s.t, p: s.p })
  }
  out.push({ t: t, p: Math.round(percent) })
  return out
}

function parseHistory(text) {
  try {
    var list = JSON.parse(String(text))
    return Array.isArray(list) ? list.filter(function (s) { return s && isFinite(s.t) && isFinite(s.p) }) : []
  } catch (e) { return [] }
}

// Fold samples into `count` equal time buckets (last sample per bucket;
// empty buckets carry the previous value). Returns percentages, oldest first.
function historyBuckets(list, count) {
  if (!list || list.length === 0 || count < 1) return []
  var start = list[0].t
  var span = Math.max(1, list[list.length - 1].t - start)
  var out = []
  var j = 0
  var last = list[0].p
  for (var b = 0; b < count; b++) {
    var end = start + span * (b + 1) / count
    while (j < list.length && list[j].t <= end) { last = list[j].p; j++ }
    out.push(last)
  }
  return out
}

// "2–92% over 38h 19m · now 92%"
function historySummary(list) {
  if (!list || list.length === 0) return ""
  var lo = 100, hi = 0
  for (var i = 0; i < list.length; i++) { lo = Math.min(lo, list[i].p); hi = Math.max(hi, list[i].p) }
  var span = (list[list.length - 1].t - list[0].t) / 60000
  return lo + "–" + hi + "% over " + formatDuration(span) + " · now " + list[list.length - 1].p + "%"
}
