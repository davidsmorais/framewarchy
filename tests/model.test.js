// Model.js tests, run under node by tests/run. The file under test is pure
// ES5 with top-level function declarations, so reading it and evaluating it
// here exercises exactly the code the shell runs.

const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
eval(source)

let pass = 0
let fail = 0
function check(name, condition) {
  if (condition) { pass++; console.log("ok    " + name) }
  else { fail++; console.log("FAIL  " + name) }
}

// ---- parseDiscovery ----
const d = parseDiscovery("fan=/sys/class/hwmon/hwmon7/fan1_input\ntemp=/sys/class/hwmon/hwmon7/temp2_input\n")
check("parseDiscovery: fan path", d.fanPath === "/sys/class/hwmon/hwmon7/fan1_input")
check("parseDiscovery: temp path", d.tempPath === "/sys/class/hwmon/hwmon7/temp2_input")
const dEmpty = parseDiscovery("")
check("parseDiscovery: missing lines are empty", dEmpty.fanPath === "" && dEmpty.tempPath === "")
const dMarked = parseDiscovery('fan=<img src="https://example.invalid/x">\ntemp=/ok')
check("parseDiscovery: markup-shaped input stays data", dMarked.fanPath === '<img src="https://example.invalid/x">')

// ---- parseState ----
const state = JSON.stringify({ protocolVersion: 1, mode: "manual", dutyPercent: 40, bootId: "boot-1", updated: 1 })
check("parseState: manual with matching boot id", parseState(state, "boot-1").mode === "manual")
check("parseState: duty read back", parseState(state, "boot-1").dutyPercent === 40)
check("parseState: stale boot id falls back to auto", parseState(state, "boot-2").mode === "auto")
check("parseState: stale boot id zeroes duty", parseState(state, "boot-2").dutyPercent === 0)
check("parseState: boot id with surrounding whitespace trimmed", parseState(state, " boot-1\n").mode === "manual")
check("parseState: auto mode stays auto", parseState(JSON.stringify({ mode: "auto", dutyPercent: 0, bootId: "b" }), "b").mode === "auto")
check("parseState: broken json is auto", parseState("not json {", "b").mode === "auto")
check("parseState: markup-shaped state is auto", parseState('<img src="x">', "b").mode === "auto")

// ---- parseRpm / parseTempC ----
check("parseRpm: bare integer", parseRpm("3120\n") === 3120)
check("parseRpm: zero", parseRpm("0\n") === 0)
check("parseRpm: garbage is 0", parseRpm("<b>x</b>") === 0)
check("parseRpm: negative is 0", parseRpm("-5") === 0)
check("parseTempC: millidegrees", parseTempC("65000\n") === 65)
check("parseTempC: rounding", parseTempC("65499") === 65)
check("parseTempC: garbage is -1", parseTempC("abc") === -1)

// ---- clampDuty ----
check("clampDuty: snaps to step 10", clampDuty(43, 50) === 40)
check("clampDuty: floor is 10", clampDuty(1, 50) === 10)
check("clampDuty: ceiling is 100", clampDuty(140, 50) === 100)
check("clampDuty: NaN falls back", clampDuty("abc", 50) === 50)
check("clampDuty: NaN with NaN default is 50", clampDuty("x", "y") === 50)

// ---- compactRpm / barLabel / formatTemp ----
check("compactRpm: thousands compacted", compactRpm(6105) === "6.1k")
check("compactRpm: small rpm kept", compactRpm(740) === "740")
check("compactRpm: zero rpm is off", compactRpm(0) === "off")
check("formatTemp: positive", formatTemp(65) === "65°")
check("formatTemp: unknown is dash", formatTemp(-1) === "—")

// ---- fanPercentAuto / heatLevel ----
check("fanPercentAuto: rpm against ceiling", fanPercentAuto(6030, FAN_MAX_RPM) === 72)
check("fanPercentAuto: zero rpm", fanPercentAuto(0, FAN_MAX_RPM) === 0)
check("fanPercentAuto: clamped at ceiling", fanPercentAuto(99999, FAN_MAX_RPM) === 100)
check("fanPercentAuto: missing ceiling is 0", fanPercentAuto(6000, 0) === 0)
check("fanPercentAuto: garbage rpm is 0", fanPercentAuto("<b>x</b>", FAN_MAX_RPM) === 0)
check("heatLevel: calm below 75", heatLevel(74) === "calm")
check("heatLevel: warm from 75", heatLevel(75) === "warm")
check("heatLevel: hot from 90", heatLevel(90) === "hot")
check("heatLevel: unknown reading", heatLevel(-1) === "unknown")

// ---- markup-shaped input never produces interpretable output sinks ----
check("fanPercentAuto: garbage stays 0", fanPercentAuto("<i>hi</i>", FAN_MAX_RPM) === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
