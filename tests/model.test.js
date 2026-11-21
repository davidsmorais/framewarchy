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
check("parseState: curve default is stock", parseState(state, "boot-1").curve === "stock")
check("parseState: quiet curve read back", parseState(JSON.stringify({ mode: "auto", curve: "quiet", bootId: "b" }), "b").curve === "quiet")
check("parseState: silent curve read back", parseState(JSON.stringify({ mode: "manual", dutyPercent: 40, curve: "silent", bootId: "b" }), "b").curve === "silent")
check("parseState: unknown curve is stock", parseState(JSON.stringify({ mode: "auto", curve: "<img>", bootId: "b" }), "b").curve === "stock")

// ---- parseCurves ----
check("parseCurves: quiet", parseCurves('{"protocolVersion":1,"curve":"quiet"}') === "quiet")
check("parseCurves: silent", parseCurves('{"curve":"silent"}') === "silent")
check("parseCurves: custom", parseCurves('{"curve":"custom"}') === "custom")
check("parseCurves: broken json is unknown", parseCurves("not json") === "unknown")
check("parseCurves: unexpected value is unknown", parseCurves('{"curve":"<img>"}') === "unknown")
check("parseCurves: markup-shaped input is unknown", parseCurves('<img src="x">') === "unknown")

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

// ---- battery ----
const bat = parseBattery("POWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_CAPACITY=92\nPOWER_SUPPLY_CYCLE_COUNT=19\nPOWER_SUPPLY_VOLTAGE_NOW=16000000\nPOWER_SUPPLY_VOLTAGE_MIN_DESIGN=15000000\nPOWER_SUPPLY_CURRENT_NOW=2000000\nPOWER_SUPPLY_CHARGE_FULL=3000000\nPOWER_SUPPLY_CHARGE_NOW=2000000\n")
check("parseBattery: percent", bat.percent === 92 && bat.present)
check("parseBattery: watts", Math.abs(bat.watts - 32) < 0.01)
check("parseBattery: size Wh", Math.abs(bat.sizeWh - 45) < 0.01)
check("parseBattery: minutes left", Math.round(bat.minutes) === 60)
check("parseBattery: empty is absent", parseBattery("").present === false)
check("batteryLevel: bands", batteryLevel(80, "Discharging") === "full" && batteryLevel(40, "Discharging") === "ok" && batteryLevel(20, "Discharging") === "low" && batteryLevel(5, "Discharging") === "critical")
check("batteryLevel: charging wins", batteryLevel(5, "Charging") === "charging")
check("formatDuration", formatDuration(125) === "2h 05m" && formatDuration(42) === "42m" && formatDuration(-1) === "—")
const cons = parseConsumers("chrome 10.0\nIsolated Web Co 3.5\nchrome 5\nidle 0.0\n", 5)
check("parseConsumers: sums per name, sorted", cons.length === 2 && cons[0].name === "chrome" && cons[0].cpu === 15)
const topOut = "top - 1\n  PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND\n 1 a 20 0 1 1 1 S 99.0 1 0:01 old\ntop - 2\n  PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND\n 2 a 20 0 1 1 1 S 12.5 1 0:01 chrome\n 3 a 20 0 1 1 1 S 7,5 1 0:01 chrome\n 4 a 20 0 1 1 1 R 50.0 1 0:01 top\n"
const topList = parseTop(topOut, 5)
check("parseTop: last iteration, summed, top excluded", topList.length === 1 && topList[0].name === "chrome" && topList[0].cpu === 20)
check("pushHistory: drops old samples", pushHistory([{ t: 0, p: 50 }], HISTORY_MAX_MS + 10, 40).length === 1)
check("historySummary", historySummary([{ t: 0, p: 2 }, { t: 60000, p: 92 }]) === "2–92% over 1m · now 92%")
check("historyBuckets: count", historyBuckets([{ t: 0, p: 10 }, { t: 100, p: 20 }], 4).length === 4)
check("parseDiscovery: bat path", parseDiscovery("bat=/x/uevent").batPath === "/x/uevent")

// ---- charge window ----
check("clampChargeWindow: defaults pass through", JSON.stringify(clampChargeWindow(99, 85)) === '{"stop":99,"start":85}')
check("clampChargeWindow: stop capped at 99", clampChargeWindow(100, 85).stop === 99)
check("clampChargeWindow: start kept below stop", clampChargeWindow(70, 90).start === 69)
check("clampChargeWindow: start floored at 20", clampChargeWindow(80, 5).start === 20)
check("clampChargeWindow: NaN falls back to defaults", JSON.stringify(clampChargeWindow("x", "y")) === '{"stop":99,"start":85}')
const ch = parseCharge('{"enabled":true,"stopPercent":90,"startPercent":80,"holding":true}')
check("parseCharge: reads window", ch.enabled && ch.stop === 90 && ch.start === 80 && ch.holding)
check("parseCharge: garbage is disabled defaults", !parseCharge("nope").enabled && parseCharge("nope").stop === 99)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
