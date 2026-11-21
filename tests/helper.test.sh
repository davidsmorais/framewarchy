#!/usr/bin/env bash
#
# Helper tests: drive bin/omarchy-fanctl against a fake sysfs tree and a fake
# ectool, with OMARCHY_FANCTL_ALLOW_UNPRIVILEGED=1 lifting the root check.
# Every case prints its name; a failing assertion exits non-zero.

set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
plugin_dir=$(cd -- "$here/.." && pwd)
helper=$plugin_dir/bin/omarchy-fanctl
discover=$plugin_dir/bin/discover-fan

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

export OMARCHY_FANCTL_STATE_DIR=$work/state
export OMARCHY_FANCTL_ALLOW_UNPRIVILEGED=1
mkdir -p "$OMARCHY_FANCTL_STATE_DIR" "$work/bin"

# The fake ectool records its arguments and answers like the real one. The
# thermal engine keeps its thresholds in a file, so thermalset/thermalget
# round-trip the way the real EC does.
cat > "$work/bin/ectool" <<'EOF'
#!/usr/bin/env bash
log="$(dirname -- "$0")/ectool.log"
printf '%s\n' "$*" >> "$log"
case "$1" in
  fanduty)     echo "Fan duty cycle set for all fans." ;;
  autofanctrl) echo "Automatic fan control is now on for fan 0" ;;
  thermalset)
    thresholds="$(dirname -- "$0")/thresholds"
    sid=$2; off=$6; max=$7
    grep -v "^$sid " "$thresholds" > "$thresholds.new" 2>/dev/null || true
    printf '%s %s %s\n' "$sid" "$off" "$max" >> "$thresholds.new"
    sort -n -k1 "$thresholds.new" > "$thresholds"
    rm -f "$thresholds.new"
    ;;
  thermalget)
    echo "sensor  warn  high  halt   fan_off fan_max   name"
    while read -r sid off max; do
      printf '  %s      0     0      0      %-7s %-9s sensor-%s\n' "$sid" "$off" "$max" "$sid"
    done < "$(dirname -- "$0")/thresholds"
    ;;
  *) echo "unexpected command: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/ectool"
# Stock thresholds, in the same shape `ectool thermalget` reports.
cat > "$work/bin/thresholds" <<'EOF'
0 313 328
1 323 341
3 313 342
4 328 358
EOF
export PATH="$work/bin:$PATH"

# A cros_ec hwmon with a fan and a CPU-labeled sensor, plus coretemp's
# package sensor — which discover must prefer for the displayed temp.
mkdir -p "$work/hwmon/hwmon7" "$work/hwmon/hwmon6"
echo cros_ec      > "$work/hwmon/hwmon7/name"
echo 3120        > "$work/hwmon/hwmon7/fan1_input"
echo cpu_f75303@4d > "$work/hwmon/hwmon7/temp2_label"
echo 65000       > "$work/hwmon/hwmon7/temp2_input"
echo ddr_f75303@4d > "$work/hwmon/hwmon7/temp3_label"
echo 42000       > "$work/hwmon/hwmon7/temp3_input"
echo coretemp    > "$work/hwmon/hwmon6/name"
echo "Package id 0" > "$work/hwmon/hwmon6/temp1_label"
echo 101000      > "$work/hwmon/hwmon6/temp1_input"
export OMARCHY_FANCTL_TEST_ROOT=$work/hwmon

pass=0
fail_count=0

check() { # check <name> <condition-result>
  if [ "$2" = 0 ]; then
    pass=$((pass + 1))
    printf 'ok    %s\n' "$1"
  else
    fail_count=$((fail_count + 1))
    printf 'FAIL  %s\n' "$1"
  fi
}

contains() { printf '%s' "$2" | grep -Fq -- "$1"; }
log_has() { [ -f "$work/bin/ectool.log" ] && contains "$1" "$(cat "$work/bin/ectool.log")"; }

# ---- status before any control -----------------------------------------
out=$("$helper" status)
contains '"available":true' "$out";        check "status: available" $?
contains '"rpm":3120' "$out";              check "status: rpm from fake fan1_input" $?
contains '"cpuTempC":65' "$out";           check "status: cpu temp from cpu-labeled sensor" $?
contains '"mode":"auto"' "$out";           check "status: auto without state file" $?

# ---- discover ------------------------------------------------------------
out=$("$discover")
contains "fan=$work/hwmon/hwmon7/fan1_input" "$out";  check "discover: fan path" $?
contains "temp=$work/hwmon/hwmon6/temp1_input" "$out"; check "discover: prefers coretemp package temp" $?

# Without coretemp, the EC's CPU-labeled sensor is the fallback.
rm -rf "$work/hwmon/hwmon6"
out=$("$discover")
contains "temp=$work/hwmon/hwmon7/temp2_input" "$out"; check "discover: falls back to EC cpu temp" $?
mkdir -p "$work/hwmon/hwmon6"
echo coretemp    > "$work/hwmon/hwmon6/name"
echo "Package id 0" > "$work/hwmon/hwmon6/temp1_label"
echo 101000      > "$work/hwmon/hwmon6/temp1_input"

# ---- manual control ------------------------------------------------------
"$helper" manual 40 >/dev/null 2>&1;      check "manual 40: exit 0" $?
log_has "fanduty 40";                      check "manual 40: ectool fanduty 40" $?
state=$(cat "$OMARCHY_FANCTL_STATE_DIR/state.json")
contains '"mode":"manual"' "$state";      check "manual 40: state manual" $?
contains '"dutyPercent":40' "$state";     check "manual 40: state duty 40" $?

out=$("$helper" status)
contains '"mode":"manual"' "$out";        check "status: reports manual mode" $?
contains '"dutyPercent":40' "$out";       check "status: reports manual duty" $?

# ---- invalid duties never reach ectool ----------------------------------
before=$(cat "$work/bin/ectool.log" 2>/dev/null || printf '')
"$helper" manual 5 >/dev/null 2>&1;       [ $? -ne 0 ]; check "manual 5: rejected" $?
"$helper" manual 0 >/dev/null 2>&1;       [ $? -ne 0 ]; check "manual 0: rejected" $?
"$helper" manual abc >/dev/null 2>&1;     [ $? -ne 0 ]; check "manual abc: rejected" $?
"$helper" manual 105 >/dev/null 2>&1;     [ $? -ne 0 ]; check "manual 105: rejected" $?
after=$(cat "$work/bin/ectool.log" 2>/dev/null || printf '')
[ "$before" = "$after" ];                 check "rejected duties: ectool not called" $?

# ---- back to automatic ---------------------------------------------------
"$helper" auto >/dev/null 2>&1;           check "auto: exit 0" $?
log_has "autofanctrl 0";                   check "auto: ectool autofanctrl 0" $?
state=$(cat "$OMARCHY_FANCTL_STATE_DIR/state.json")
contains '"mode":"auto"' "$state";        check "auto: state auto" $?

# ---- automatic curve presets --------------------------------------------
"$helper" curve quiet >/dev/null 2>&1;    check "curve quiet: exit 0" $?
log_has "thermalset 1 0 361 371 329 347"; check "curve quiet: cpu sensor shifted +6" $?
log_has "thermalset 0 0 361 371 319 334"; check "curve quiet: local sensor shifted +6" $?
if log_has "thermalset 2 "; then false; else true; fi
                                          check "curve quiet: battery sensor untouched" $?
state=$(cat "$OMARCHY_FANCTL_STATE_DIR/state.json")
contains '"curve":"quiet"' "$state";      check "curve quiet: state curve quiet" $?
contains '"mode":"auto"' "$state";        check "curve quiet: mode preserved" $?

out=$("$helper" curves)
contains '"curve":"quiet"' "$out";        check "curves: reports quiet from thermalget" $?

"$helper" curve silent >/dev/null 2>&1;   check "curve silent: exit 0" $?
out=$("$helper" curves)
contains '"curve":"silent"' "$out";       check "curves: reports silent" $?

"$helper" curve stock >/dev/null 2>&1;    check "curve stock: exit 0" $?
out=$("$helper" curves)
contains '"curve":"stock"' "$out";        check "curves: back to stock" $?
state=$(cat "$OMARCHY_FANCTL_STATE_DIR/state.json")
contains '"curve":"stock"' "$state";      check "curve stock: state curve stock" $?

before=$(cat "$work/bin/ectool.log" 2>/dev/null || printf '')
"$helper" curve abc >/dev/null 2>&1;      [ $? -ne 0 ]; check "curve abc: rejected" $?
after=$(cat "$work/bin/ectool.log" 2>/dev/null || printf '')
[ "$before" = "$after" ];                 check "curve abc: ectool not called" $?

# A curve change keeps the current mode and duty.
"$helper" manual 60 >/dev/null 2>&1;      check "manual 60: exit 0" $?
"$helper" curve quiet >/dev/null 2>&1;    check "curve quiet in manual: exit 0" $?
state=$(cat "$OMARCHY_FANCTL_STATE_DIR/state.json")
contains '"mode":"manual"' "$state";      check "curve in manual: mode kept" $?
contains '"dutyPercent":60' "$state";     check "curve in manual: duty kept" $?
"$helper" curve stock >/dev/null 2>&1
"$helper" auto >/dev/null 2>&1

# ---- a state file from an earlier boot means automatic ------------------
printf '{"protocolVersion":1,"mode":"manual","dutyPercent":40,"bootId":"stale-boot","updated":1}\n' \
  > "$OMARCHY_FANCTL_STATE_DIR/state.json"
out=$("$helper" status)
contains '"mode":"auto"' "$out";          check "stale boot id: reported as auto" $?
contains '"dutyPercent":0' "$out";        check "stale boot id: duty zeroed" $?

# ---- no cros_ec fan ------------------------------------------------------
empty=$(mktemp -d)
out=$(OMARCHY_FANCTL_TEST_ROOT=$empty "$helper" status)
contains '"available":false' "$out"; check "no fan: status reports unavailable" $?
rm -rf -- "$empty"

# ---- unprivileged without the test escape hatch -------------------------
if [ "$(id -u)" -ne 0 ]; then
  OMARCHY_FANCTL_ALLOW_UNPRIVILEGED= OMARCHY_FANCTL_TEST_ROOT=$work/hwmon "$helper" auto >/dev/null 2>&1
  [ $? -ne 0 ];                           check "unprivileged auto: refused" $?
else
  printf 'skip  unprivileged auto: running as root\n'
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail_count"
[ "$fail_count" -eq 0 ]
