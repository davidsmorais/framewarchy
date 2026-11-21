// Pure logic for io.github.davidsmorais.omarchy-framework-fan-control: parsing sensor files, the helper's state
// file, and the numbers shown in the bar. No QML imports, so the test
// suite runs this file under node unchanged.

// discover-fan output ("fan=..."/"temp=..." lines) into one object.
// Missing lines become empty strings, so a missing sensor is not an error.
function parseDiscovery(text) {
  var out = { fanPath: "", tempPath: "" }
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf("fan=") === 0) out.fanPath = line.slice(4)
    else if (line.indexOf("temp=") === 0) out.tempPath = line.slice(5)
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
