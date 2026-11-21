import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Framework fan control: RPM and the EC's CPU temperature read straight
// from the cros_ec hwmon (no process per reading), duty driven through the
// whitelisted omarchy-fanctl helper (sudo -n, never a password prompt).
//
//   left click   - open/close the panel
//   right click  - restore automatic control (panic button while manual)
//   panel keys   - 1/2/3 presets, A automatic, Esc closes
//
// The slider stages while automatic: moving it never touches the fan until
// Manual is engaged. Presets engage manual control directly. A duty pinned
// before suspend is returned to automatic by the system-sleep hook, and the
// EC forgets manual duties on reboot, which the boot-id check catches.
Panel {
  id: root
  moduleName: "io.github.davidsmorais.omarchy-framework-fan-control"
  ipcTarget: "io.github.davidsmorais.omarchy-framework-fan-control"
  manageIpc: false

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }
  function tr(key) { return strings.t(key) }
  function localPath(url) { return decodeURIComponent(String(url).replace(/^file:\/\//, "")) }

  readonly property bool vertical: bar ? bar.vertical : false
  readonly property string icon: "󰈐"
  readonly property string thermometerIcon: "󰔏"

  // What the bar reads out. In manual mode the duty is the exact command;
  // in automatic mode it is the fan's speed against its measured ceiling.
  readonly property int fanPercent: manual ? dutyPercent : Model.fanPercentAuto(rpmValue, Model.FAN_MAX_RPM)
  readonly property string heat: Model.heatLevel(cpuTempC)
  readonly property color heatColor: heat === "hot" ? Commons.Color.urgent
    : heat === "warm" ? "#d0a215"
    : heat === "unknown" ? root.barForeground
    : Commons.Color.accent
  // The fan answers a click in the panel, so its color carries the mode.
  readonly property color fanColor: manual ? Commons.Color.accent : root.barForeground

  readonly property string valueText: {
    if (!available) return "—"
    var percent = Commons.I18n.formatNumber(fanPercent, 0)
    var rpm = Commons.I18n.formatNumber(rpmValue, 0)
    var temp = cpuTempC >= 0 ? Commons.I18n.formatNumber(cpuTempC, 0) + "°" : "—"
    return percent + "% · " + rpm + " RPM · CPU " + temp
  }

  // ---- state ----------------------------------------------------------
  property var found: ({ fanPath: "", tempPath: "" })
  property int rpmValue: 0
  property int cpuTempC: -1
  property string mode: "auto"
  property int dutyPercent: 0
  property int stagedPercent: Model.clampDuty(setting("defaultManualPercent", 50), 50)
  property string errorText: ""
  property bool applying: false
  property bool dragging: false
  property string curve: "stock"

  readonly property bool available: found.fanPath !== ""
  // Reading an installed binary as text only answers "is it here": search
  // it for a string that must be inside it, never display the content.
  readonly property bool helperOk: helperFile.text().indexOf("omarchy-fanctl") >= 0
  readonly property bool ectoolOk: ectoolFile.text().indexOf("fanduty") >= 0
  readonly property bool controllable: available && helperOk && ectoolOk
  readonly property bool manual: mode === "manual"

  onOpenedChanged: {
    if (!opened) return
    discoverProc.running = true
    curvesProc.running = true
  }

  // ---- finding the sensors ---------------------------------------------
  Process {
    id: discoverProc
    command: ["bash", root.localPath(Qt.resolvedUrl("bin/discover-fan"))]
    running: true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.found = Model.parseDiscovery(text)
    }
  }

  // ---- reading the sensors (closed files, no process) ------------------
  FileView {
    id: rpmFile
    path: root.available ? root.found.fanPath : ""
    blockLoading: true
    printErrors: false
    onLoaded: root.rpmValue = Model.parseRpm(text())
  }

  FileView {
    id: tempFile
    path: root.available && root.found.tempPath !== "" ? root.found.tempPath : ""
    blockLoading: true
    printErrors: false
    onLoaded: root.cpuTempC = Model.parseTempC(text())
  }

  FileView {
    id: stateFile
    path: "/var/lib/omarchy-fanctl/state.json"
    blockLoading: true
    printErrors: false
    onLoaded: {
      var s = Model.parseState(text(), bootFile.text())
      root.mode = s.mode
      root.dutyPercent = s.dutyPercent
      root.curve = s.curve
      if (s.mode === "manual" && !root.dragging) root.stagedPercent = s.dutyPercent
    }
  }

  FileView { id: bootFile; path: "/proc/sys/kernel/random/boot_id"; blockLoading: true; printErrors: false }

  // Presence checks for the privileged helper and ectool.
  FileView { id: helperFile; path: "/usr/local/libexec/omarchy-fanctl"; printErrors: false }
  FileView { id: ectoolFile; path: "/usr/bin/ectool"; printErrors: false }

  Timer {
    interval: 2000
    running: true
    repeat: true
    onTriggered: {
      rpmFile.reload()
      tempFile.reload()
      stateFile.reload()
    }
  }

  // ---- controlling the fan ----------------------------------------------
  // The helper confirms each command by rewriting the state file; the
  // properties update optimistically here so the UI answers the click
  // itself, and the next state read reconciles with what the EC really has.
  function applyAuto() {
    if (!controllable || applying) return
    errorText = ""
    applying = true
    mode = "auto"
    dutyPercent = 0
    applyProc.command = ["sudo", "-n", "/usr/local/libexec/omarchy-fanctl", "auto"]
    applyProc.running = true
  }

  function applyManual(percent) {
    if (!controllable || applying) return
    stagedPercent = Model.clampDuty(percent, stagedPercent)
    errorText = ""
    applying = true
    mode = "manual"
    dutyPercent = stagedPercent
    applyProc.command = ["sudo", "-n", "/usr/local/libexec/omarchy-fanctl", "manual", String(stagedPercent)]
    applyProc.running = true
  }

  Process {
    id: applyProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") root.errorText = text.trim()
    }
    onExited: function(code) {
      root.applying = false
      if (code === 0) stateFile.reload()
    }
  }

  // ---- shaping the automatic curve ---------------------------------------
  // The EC's own thermal thresholds decide when automatic mode ramps the
  // fan. Presets shift the ramp (never the warn/critical thresholds), the
  // EC resets to stock on full power-off, and the widget takes its truth
  // from `curves` — a thermalget read — rather than the state file.
  function applyCurve(name) {
    if (!controllable || applying) return
    if (name !== "stock" && name !== "quiet" && name !== "silent") return
    errorText = ""
    applying = true
    curve = name
    curveProc.command = ["sudo", "-n", "/usr/local/libexec/omarchy-fanctl", "curve", name]
    curveProc.running = true
  }

  Process {
    id: curveProc
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") root.errorText = text.trim()
    }
    onExited: function(code) {
      root.applying = false
      if (code === 0) {
        stateFile.reload()
        curvesProc.running = true
      }
    }
  }

  Process {
    id: curvesProc
    command: ["sudo", "-n", "/usr/local/libexec/omarchy-fanctl", "curves"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var read = Model.parseCurves(text)
        if (read !== "unknown") root.curve = read
      }
    }
    stderr: StdioCollector { waitForEnd: true }
  }

  // Once the presence checks have loaded, ask the EC which curve is live.
  Timer {
    interval: 800
    running: true
    repeat: false
    onTriggered: if (root.helperOk && root.ectoolOk) curvesProc.running = true
  }

  // ---- IPC ---------------------------------------------------------------
  IpcHandler {
    target: "io.github.davidsmorais.omarchy-framework-fan-control"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function auto(): void { root.applyAuto() }
    function manual(percent: int): void { root.applyManual(percent) }
    function curve(name: string): void { root.applyCurve(name) }
    function state(): string {
      return JSON.stringify({
        available: root.available,
        controllable: root.controllable,
        mode: root.mode,
        dutyPercent: root.dutyPercent,
        stagedPercent: root.stagedPercent,
        curve: root.curve,
        rpm: root.rpmValue,
        cpuTempC: root.cpuTempC,
        error: root.errorText
      })
    }
  }

  // ---- bar ---------------------------------------------------------------
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // The bar: fan percentage and CPU temperature, each with its own glyph
  // and state color. Width comes from the content row itself, so the slot
  // always fits what it paints.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.vertical ? -1 : Math.ceil(contentRow.implicitWidth + button.scaledHorizontalMargin * 2)
    fixedHeight: root.vertical ? Style.bar.iconSlot : -1
    horizontalMargin: 10.5
    tooltipText: {
      if (!root.available) return root.tr("status.noFan")
      var rpm = Commons.I18n.formatNumber(root.rpmValue, 0)
      var temp = root.cpuTempC >= 0 ? Commons.I18n.formatNumber(root.cpuTempC, 0) : "—"
      return root.manual
        ? root.tr("tooltip.manual").arg(root.dutyPercent).arg(rpm).arg(temp)
        : root.tr("tooltip.auto").arg(rpm).arg(temp)
    }
    onPressed: function(b) {
      if (b === Qt.RightButton) { if (root.manual) root.applyAuto() }
      else root.toggle()
    }

    Row {
      id: contentRow
      visible: !root.vertical
      anchors.centerIn: parent
      spacing: Style.space(4)
      scale: button.pressScale

      OpticalGlyph {
        width: Style.bar.iconCanvas
        height: Style.bar.iconCanvas
        text: root.icon
        fontFamily: button.fontFamily
        fontSize: Style.bar.iconFont
        paintedSize: Style.bar.iconSize
        color: root.fanColor
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        textFormat: Text.PlainText
        text: root.fanPercent + "%"
        color: root.fanColor
        font.family: button.fontFamily
        font.pixelSize: Style.bar.iconFont
        font.features: { "tnum": 1 }
        anchors.verticalCenter: parent.verticalCenter
      }

      Item { width: Style.space(8); height: 1 }

      OpticalGlyph {
        width: Style.bar.iconCanvas
        height: Style.bar.iconCanvas
        text: root.thermometerIcon
        fontFamily: button.fontFamily
        fontSize: Style.bar.iconFont
        paintedSize: Style.bar.iconSize
        color: root.heatColor
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        textFormat: Text.PlainText
        text: Model.formatTemp(root.cpuTempC)
        color: root.heatColor
        font.family: button.fontFamily
        font.pixelSize: Style.bar.iconFont
        font.features: { "tnum": 1 }
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    // A vertical bar keeps the fan glyph alone.
    OpticalGlyph {
      visible: root.vertical
      anchors.centerIn: parent
      width: Style.bar.iconCanvas
      height: Style.bar.iconCanvas
      text: root.icon
      fontFamily: button.fontFamily
      fontSize: Style.bar.iconFont
      paintedSize: Style.bar.iconSize
      color: root.fanColor
    }
  }

  // ---- popup ---------------------------------------------------------------
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight + Style.space(6))

    // Built the first time the popup opens, not at shell start.
    content: Component {
      PanelKeyCatcher {
        id: keyCatcher
        anchors.fill: parent
        implicitHeight: column.implicitHeight
        onCloseRequested: root.close()
        onTabRequested: function(direction) { root.switchPanel(direction) }
        onTextKey: function(t) {
          t = String(t).toLowerCase()
          if (t === "1") root.applyManual(30)
          else if (t === "2") root.applyManual(60)
          else if (t === "3") root.applyManual(100)
          else if (t === "a") root.applyAuto()
        }

        Column {
          id: column
          width: parent.width
          spacing: Style.space(12)

          // Header: icon and title on the left, mode chip and read-out on
          // the right. All numeric, so plain text is all it needs.
          Item {
            width: parent.width
            implicitHeight: headerRow.implicitHeight

            Row {
              id: headerRow
              spacing: Style.space(8)

              Text {
                textFormat: Text.PlainText
                text: root.icon
                color: root.manual ? Commons.Color.accent : root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.icon
                anchors.verticalCenter: parent.verticalCenter
              }

              Text {
                textFormat: Text.PlainText
                text: root.tr("title")
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
                anchors.verticalCenter: parent.verticalCenter
              }
            }

            Text {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: root.valueText
              color: root.barForeground
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.body
              font.bold: true
              font.features: { "tnum": 1 }
            }
          }

          // ---- availability problems come before the controls ----
          Text {
            visible: !root.available
            width: parent.width
            textFormat: Text.PlainText
            text: root.tr("status.noFan")
            color: Qt.darker(root.barForeground, 1.4)
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          Text {
            visible: root.available && !root.controllable
            width: parent.width
            textFormat: Text.PlainText
            text: root.tr("status.noHelper")
            color: Qt.darker(root.barForeground, 1.4)
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          // ---- mode ----
          PanelSectionHeader {
            width: parent.width
            text: root.tr("section.control")
          }

          Row {
            spacing: Style.space(8)

            Button {
              text: root.tr("mode.auto")
              selected: !root.manual
              enabled: root.controllable && !root.applying
              onClicked: root.applyAuto()
            }

            Button {
              text: root.tr("mode.manual")
              selected: root.manual
              enabled: root.controllable && !root.applying
              onClicked: root.applyManual(root.stagedPercent)
            }
          }

          // ---- automatic curve ----
          PanelSectionHeader {
            width: parent.width
            text: root.tr("section.curve")
          }

          Row {
            spacing: Style.space(8)

            Button {
              text: root.tr("curve.stock")
              selected: root.curve === "stock"
              enabled: root.controllable && !root.applying
              onClicked: root.applyCurve("stock")
            }

            Button {
              text: root.tr("curve.quiet")
              selected: root.curve === "quiet"
              enabled: root.controllable && !root.applying
              onClicked: root.applyCurve("quiet")
            }

            Button {
              text: root.tr("curve.silent")
              selected: root.curve === "silent"
              enabled: root.controllable && !root.applying
              onClicked: root.applyCurve("silent")
            }
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.tr("hint.curve")
            color: Qt.darker(root.barForeground, 1.4)
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ---- presets ----
          PanelSectionHeader {
            width: parent.width
            text: root.tr("section.presets")
          }

          Row {
            spacing: Style.space(8)

            Button {
              text: root.tr("preset.quiet") + " · 30%"
              selected: root.manual && root.dutyPercent === 30
              enabled: root.controllable && !root.applying
              onClicked: root.applyManual(30)
            }

            Button {
              text: root.tr("preset.balanced") + " · 60%"
              selected: root.manual && root.dutyPercent === 60
              enabled: root.controllable && !root.applying
              onClicked: root.applyManual(60)
            }

            Button {
              text: root.tr("preset.full") + " · 100%"
              selected: root.manual && root.dutyPercent === 100
              enabled: root.controllable && !root.applying
              onClicked: root.applyManual(100)
            }
          }

          // ---- duty slider, below the presets ----
          Row {
            width: parent.width
            spacing: Style.space(8)

            PanelSlider {
              id: dutySlider
              width: parent.width - dutyLabel.width - parent.spacing
              bar: root.bar
              minimum: 10
              maximum: 100
              step: 10
              integer: true
              tickCount: 10
              value: root.stagedPercent
              onMoved: function(v) {
                root.dragging = true
                root.stagedPercent = Model.clampDuty(v, root.stagedPercent)
              }
              onReleased: function(v) {
                root.dragging = false
                root.stagedPercent = Model.clampDuty(v, root.stagedPercent)
                if (root.manual) root.applyManual(root.stagedPercent)
              }
            }

            Text {
              id: dutyLabel
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: root.stagedPercent + "%"
              color: root.manual ? Commons.Color.accent : root.barForeground
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.body
              font.bold: true
              font.features: { "tnum": 1 }
            }
          }

          Text {
            visible: !root.manual
            width: parent.width
            textFormat: Text.PlainText
            text: root.tr("hint.staged").arg(root.stagedPercent)
            color: Qt.darker(root.barForeground, 1.4)
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            visible: root.errorText !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.tr("status.error").arg(root.errorText)
            color: Commons.Color.urgent
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: root.tr("hint.keys")
            color: Qt.darker(root.barForeground, 1.6)
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
