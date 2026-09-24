//go:build windows

package main

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"github.com/compumark/verselink-telemetry/internal/gamelog"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
	"github.com/compumark/verselink-telemetry/internal/settings"
)

const (
	wsCaption       = 0x00C00000
	wsSysMenu       = 0x00080000
	wsExDlgModal    = 0x00000001
	wsExToolWindow  = 0x00000080
	wsChild         = 0x40000000
	wsVisible       = 0x10000000
	wsTabStop       = 0x00010000
	wsGroup         = 0x00020000
	wsBorder        = 0x00800000
	bsAutoRadio     = 0x00000009
	bsGroupBox      = 0x00000007
	bsDefaultButton = 0x00000001
	esAutoHScroll   = 0x00000080
	ssLeft          = 0x00000000
	ssLeftNoWrap    = 0x0000000C
	ssEditControl   = 0x00002000
	ssNoPrefix      = 0x00000080

	wmSetFont    = 0x0030
	bmGetCheck   = 0x00F0
	bmSetCheck   = 0x00F1
	bnClicked    = 0
	bstChecked   = 1
	bstUnchecked = 0
	swShow       = 5

	settingsMenuID = 1004

	settingsAutoID         = 1101
	settingsManualID       = 1102
	settingsPathLabelID    = 1103
	settingsPathID         = 1104
	settingsBrowseID       = 1105
	settingsModeValueID    = 1106
	settingsSourceValueID  = 1107
	settingsChannelValueID = 1108
	settingsPathValueID    = 1109
	settingsWarningID      = 1110
	settingsCancelID       = 1111
	settingsSaveID         = 1112
	dialogCancelID         = 2
)

var (
	comdlg32              = syscall.NewLazyDLL("comdlg32.dll")
	procGetOpenFileName   = comdlg32.NewProc("GetOpenFileNameW")
	procCommonDialogError = comdlg32.NewProc("CommDlgExtendedError")
	procSendMessage       = user32.NewProc("SendMessageW")
	procSetWindowText     = user32.NewProc("SetWindowTextW")
	procGetWindowText     = user32.NewProc("GetWindowTextW")
	procSetForeground     = user32.NewProc("SetForegroundWindow")
	procEnableWindow      = user32.NewProc("EnableWindow")
	procSetFocus          = user32.NewProc("SetFocus")
	procCreateFont        = gdi32.NewProc("CreateFontW")
	procDeleteObject      = gdi32.NewProc("DeleteObject")
	procGetDpiForSystem   = user32.NewProc("GetDpiForSystem")
	procAdjustWindowRect  = user32.NewProc("AdjustWindowRectEx")
	procIsDialogMessage   = user32.NewProc("IsDialogMessageW")
	gdi32                 = syscall.NewLazyDLL("gdi32.dll")
)

type openFileName struct {
	StructSize       uint32
	Owner            uintptr
	Instance         uintptr
	Filter           *uint16
	CustomFilter     *uint16
	MaxCustomFilter  uint32
	FilterIndex      uint32
	File             *uint16
	MaxFile          uint32
	FileTitle        *uint16
	MaxFileTitle     uint32
	InitialDirectory *uint16
	Title            *uint16
	Flags            uint32
	FileOffset       uint16
	FileExtension    uint16
	DefaultExtension *uint16
	CustomData       uintptr
	Hook             uintptr
	TemplateName     *uint16
	Reserved         uintptr
	Reserved2        uint32
	FlagsEx          uint32
}

type settingsWindow struct {
	hwnd         uintptr
	auto         uintptr
	manual       uintptr
	pathLabel    uintptr
	path         uintptr
	browseButton uintptr
	values       [4]uintptr
	warning      uintptr
	errorText    uintptr
	font         uintptr
	cancelButton uintptr
	saveButton   uintptr
	store        settings.Store
	value        settings.Settings
	draft        settingsDraft
	warningText  string
	status       func() runtimehost.Status
	instance     uintptr
}

type settingsWindowRect struct {
	Left, Top, Right, Bottom int32
}

func (t *windowsTray) configureSettings(store settings.Store, value settings.Settings, warning string) {
	t.settingsStore = store
	t.settingsValue = value
	t.settingsWarning = warning
}

func (t *windowsTray) openSettings() {
	if t.settingsWindow != nil {
		procShowWindow.Call(t.settingsWindow.hwnd, swShow)
		procSetForeground.Call(t.settingsWindow.hwnd)
		return
	}
	window, err := createSettingsWindow(t.settingsStore, t.settingsValue, t.settingsWarning, t.store.Current)
	if err != nil {
		showNativeError(fmt.Sprintf("Could not open settings:\n\n%v", err))
		return
	}
	t.settingsWindow = window
	procSetFocus.Call(window.auto)
}

func createSettingsWindow(store settings.Store, value settings.Settings, warning string, status func() runtimehost.Status) (*settingsWindow, error) {
	style := uintptr(wsCaption | wsSysMenu)
	exStyle := uintptr(wsExDlgModal | wsExToolWindow)
	dpi := uint32(96)
	if got, _, _ := procGetDpiForSystem.Call(); got != 0 {
		dpi = uint32(got)
	}
	scale := func(value int32) int32 { return int32((int64(value)*int64(dpi) + 48) / 96) }
	client := settingsWindowRect{Right: scale(680), Bottom: scale(492)}
	procAdjustWindowRect.Call(uintptr(unsafe.Pointer(&client)), style, 0, exStyle)
	width, height := client.Right-client.Left, client.Bottom-client.Top
	instance, _, instanceErr := procGetModuleHandle.Call(0)
	if instance == 0 {
		return nil, windowsCallError("get application module handle", instanceErr)
	}
	className, _ := syscall.UTF16PtrFromString("VerseLinkTelemetryTrayWindow")
	title, _ := syscall.UTF16PtrFromString("VerseLink Telemetry Settings")
	hwnd, _, createErr := procCreateWindowEx.Call(exStyle, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), style, 0x80000000, 0x80000000, uintptr(width), uintptr(height), 0, 0, instance, 0)
	if hwnd == 0 {
		return nil, windowsCallError("create settings window", createErr)
	}
	window := &settingsWindow{hwnd: hwnd, instance: instance, store: store, value: value, draft: newSettingsDraft(value), warningText: warning, status: status}
	if activeTray != nil {
		activeTray.settingsWindow = window
	}
	fontHeight := -int32((9*int(dpi) + 36) / 72)
	font, _, fontErr := procCreateFont.Call(uintptr(fontHeight), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(mustUTF16("Segoe UI"))))
	if font == 0 {
		procDestroyWindow.Call(hwnd)
		return nil, windowsCallError("create settings font", fontErr)
	}
	window.font = font
	px := scale
	var controlCreationErr error
	add := func(class, text string, style uintptr, x, y, w, h int32, id uintptr) uintptr {
		control, controlErr := createSettingsControl(hwnd, class, text, style, px(x), px(y), px(w), px(h), window.instance, id)
		if controlErr != nil {
			controlCreationErr = controlErr
			return 0
		}
		procSendMessage.Call(control, wmSetFont, window.font, 1)
		return control
	}
	// Group boxes are created first so their frames remain behind their controls.
	add("BUTTON", "Game.log source", wsChild|wsVisible|bsGroupBox, 16, 12, 648, 190, 0)
	window.auto = add("BUTTON", "Automatic discovery", wsChild|wsVisible|wsTabStop|wsGroup|bsAutoRadio, 32, 38, 260, 22, settingsAutoID)
	add("STATIC", "VerseLink finds the active Star Citizen installation automatically.", wsChild|wsVisible|ssLeft, 56, 60, 590, 22, 0)
	window.manual = add("BUTTON", "Manual Game.log", wsChild|wsVisible|wsTabStop|bsAutoRadio, 32, 91, 260, 22, settingsManualID)
	window.pathLabel = add("STATIC", "Game.log path:", wsChild|wsVisible|ssLeft, 48, 119, 120, 20, settingsPathLabelID)
	window.path = add("EDIT", value.GameLog.ManualPath, wsChild|wsVisible|wsTabStop|wsBorder|esAutoHScroll, 48, 141, 488, 26, settingsPathID)
	window.browseButton = add("BUTTON", "Browse...", wsChild|wsVisible|wsTabStop, 546, 139, 96, 28, settingsBrowseID)
	add("BUTTON", "Current configuration", wsChild|wsVisible|bsGroupBox, 16, 208, 648, 222, 0)
	labels := []string{"Configured mode:", "Effective source:", "Channel:", "Game.log:"}
	labelY := []int32{234, 261, 288, 315}
	for index, label := range labels {
		add("STATIC", label, wsChild|wsVisible|ssLeft, 34, labelY[index], 116, 21, 0)
		valueStyle := uintptr(wsChild | wsVisible | ssLeftNoWrap)
		valueHeight := int32(21)
		if index == 3 {
			valueStyle = wsChild | wsVisible | ssLeft | ssEditControl
			valueHeight = 42
		}
		window.values[index] = add("STATIC", "", valueStyle, 154, labelY[index], 486, valueHeight, []uintptr{settingsModeValueID, settingsSourceValueID, settingsChannelValueID, settingsPathValueID}[index])
	}
	window.warning = add("STATIC", "", wsChild|wsVisible|ssLeft|ssEditControl|ssNoPrefix, 34, 365, 606, 43, settingsWarningID)
	window.errorText = add("STATIC", "", wsChild|wsVisible|ssLeftNoWrap, 34, 408, 606, 18, 0)
	window.autoCheck(value.GameLog.Mode != settings.ModeManual)
	window.manualCheck(value.GameLog.Mode == settings.ModeManual)
	window.setModeEnabled(value.GameLog.Mode == settings.ModeManual)
	window.cancelButton = add("BUTTON", "Cancel", wsChild|wsVisible|wsTabStop, 452, 446, 88, 28, settingsCancelID)
	window.saveButton = add("BUTTON", "Save", wsChild|wsVisible|wsTabStop|bsDefaultButton, 552, 446, 88, 28, settingsSaveID)
	if controlCreationErr != nil {
		procDestroyWindow.Call(hwnd)
		return nil, controlCreationErr
	}
	window.refreshSummary()
	procShowWindow.Call(hwnd, swShow)
	return window, nil
}

func mustUTF16(value string) *uint16 {
	encoded, _ := syscall.UTF16PtrFromString(value)
	return encoded
}

func (w *settingsWindow) autoCheck(checked bool) {
	procSendMessage.Call(w.auto, bmSetCheck, boolWord(checked), 0)
}

func (w *settingsWindow) manualCheck(checked bool) {
	procSendMessage.Call(w.manual, bmSetCheck, boolWord(checked), 0)
}

func (w *settingsWindow) manualSelected() bool {
	checked, _, _ := procSendMessage.Call(w.manual, bmGetCheck, 0, 0)
	return checked == bstChecked
}

func (w *settingsWindow) setModeEnabled(manual bool) {
	enabled := uintptr(0)
	if manual {
		enabled = 1
	}
	procEnableWindow.Call(w.pathLabel, enabled)
	procEnableWindow.Call(w.path, enabled)
	procEnableWindow.Call(w.browseButton, enabled)
}

func boolWord(value bool) uintptr {
	if value {
		return bstChecked
	}
	return bstUnchecked
}

func createSettingsControl(parent uintptr, className, text string, style uintptr, x, y, width, height int32, instance, id uintptr) (uintptr, error) {
	class, _ := syscall.UTF16PtrFromString(className)
	caption, _ := syscall.UTF16PtrFromString(text)
	hwnd, _, err := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(caption)), style, uintptr(x), uintptr(y), uintptr(width), uintptr(height), parent, id, instance, 0)
	if hwnd == 0 {
		return 0, windowsCallError("create settings control "+className, err)
	}
	return hwnd, nil
}

func windowsCallError(operation string, err error) error {
	var code syscall.Errno
	if errors.As(err, &code) && code != 0 {
		return fmt.Errorf("%s failed (Win32 error %d)", operation, uint32(code))
	}
	return fmt.Errorf("%s failed (Win32 error code unavailable; returned %T)", operation, err)
}

func (t *windowsTray) handleSettingsMessage(hwnd uintptr, msg uint32, wParam, lParam uintptr) bool {
	window := t.settingsWindow
	if window == nil || window.hwnd != hwnd {
		return false
	}
	switch msg {
	case wmClose:
		window.discardChanges()
		procShowWindow.Call(hwnd, swHide)
		return true
	case wmDestroy:
		if window.font != 0 {
			procDeleteObject.Call(window.font)
			window.font = 0
		}
		t.settingsWindow = nil
		return true
	case wmCommand:
		if wParam>>16 != bnClicked {
			return true
		}
		switch wParam & 0xffff {
		case settingsAutoID:
			window.draft.setMode(settings.ModeAuto)
			window.setModeEnabled(false)
			window.refreshSummary()
		case settingsManualID:
			window.draft.setMode(settings.ModeManual)
			window.setModeEnabled(true)
			window.refreshSummary()
		case settingsBrowseID:
			window.browse()
		case settingsSaveID:
			window.save()
		case settingsCancelID, dialogCancelID:
			window.discardChanges()
			procShowWindow.Call(window.hwnd, swHide)
		}
		return true
	}
	return false
}

func (w *settingsWindow) browse() {
	path, ok, err := chooseGameLog(w.hwnd)
	if err != nil {
		w.setError(err.Error())
		return
	}
	if !ok {
		return
	}
	if err := gamelog.ValidateGameLogPath(path, nil); err != nil {
		w.setError("Choose a readable Game.log file.")
		return
	}
	w.setPath(path)
	w.draft.setManualPath(path)
	w.draft.setMode(settings.ModeManual)
	w.setError("")
	w.manualCheck(true)
	w.autoCheck(false)
	w.setModeEnabled(true)
	w.refreshSummary()
}

func chooseGameLog(owner uintptr) (string, bool, error) {
	filter := make([]uint16, 0, 32)
	for _, item := range []string{"Game.log", "Game.log", "All files", "*.*"} {
		encoded, _ := syscall.UTF16FromString(item)
		filter = append(filter, encoded...)
	}
	filter = append(filter, 0)
	buffer := make([]uint16, 32768)
	title, _ := syscall.UTF16PtrFromString("Select Game.log")
	defaultExtension, _ := syscall.UTF16PtrFromString("log")
	request := openFileName{StructSize: uint32(unsafe.Sizeof(openFileName{})), Owner: owner, Filter: &filter[0], FilterIndex: 1, File: &buffer[0], MaxFile: uint32(len(buffer)), Title: title, DefaultExtension: defaultExtension, Flags: 0x00080000 | 0x00001000 | 0x00000800 | 0x00000008 | 0x00000004}
	result, _, _ := procGetOpenFileName.Call(uintptr(unsafe.Pointer(&request)))
	if result == 0 {
		dialogError, _, _ := procCommonDialogError.Call()
		if err := commonDialogFailure(dialogError); err != nil {
			return "", false, err
		} else {
			return "", false, nil
		}
	}
	return syscall.UTF16ToString(buffer), true, nil
}

func commonDialogFailure(code uintptr) error {
	if code == 0 {
		return nil
	}
	return fmt.Errorf("file selection failed (common dialog error %d)", uint32(code))
}

func (w *settingsWindow) save() {
	w.draft.setManualPath(w.pathText())
	if w.manualSelected() {
		w.draft.setMode(settings.ModeManual)
		path := w.draft.manualPath
		if err := gamelog.ValidateGameLogPath(path, nil); err != nil {
			w.setError("Choose a readable Game.log file before saving.")
			return
		}
	} else {
		w.draft.setMode(settings.ModeAuto)
	}
	value := w.draft.value()
	if w.store.Path == "" {
		w.setError("Settings cannot be saved because LOCALAPPDATA is unavailable.")
		return
	}
	if err := w.store.Save(value); err != nil {
		w.setError("Could not save settings. Check that the settings folder is writable.")
		return
	}
	changed := value != w.value
	w.value = value
	w.warningText = ""
	if activeTray != nil {
		activeTray.settingsValue = value
		activeTray.settingsWarning = ""
	}
	w.refreshSummary()
	w.setError("")
	if changed {
		showNativeMessage("Settings saved", "Restart VerseLink Telemetry to apply the Game.log configuration change.", mbOK|mbIconInfo)
	} else {
		showNativeMessage("Settings saved", "Your settings are saved.", mbOK|mbIconInfo)
	}
}

func (w *settingsWindow) discardChanges() {
	if activeTray != nil {
		w.value = activeTray.settingsValue
		w.warningText = activeTray.settingsWarning
	}
	w.setPath(w.value.GameLog.ManualPath)
	w.draft.reset(w.value)
	w.autoCheck(w.value.GameLog.Mode != settings.ModeManual)
	w.manualCheck(w.value.GameLog.Mode == settings.ModeManual)
	w.setModeEnabled(w.value.GameLog.Mode == settings.ModeManual)
	w.setError("")
	w.refreshSummary()
}

func (w *settingsWindow) refreshSummary() {
	configuration := w.status().Configuration
	presentation := presentConfiguration(w.value, configuration, w.warningText)
	w.setText(w.values[0], presentation.mode)
	w.setText(w.values[1], presentation.source)
	w.setText(w.values[2], presentation.channel)
	w.setText(w.values[3], presentation.path)
	w.setText(w.warning, presentation.warning)
}

func (w *settingsWindow) pathText() string {
	buffer := make([]uint16, 32768)
	length, _, _ := procGetWindowText.Call(w.path, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if length == 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer[:int(length)])
}

func (w *settingsWindow) setPath(value string)  { w.setText(w.path, value) }
func (w *settingsWindow) setError(value string) { w.setText(w.errorText, value) }
func (w *settingsWindow) setText(hwnd uintptr, value string) {
	text, _ := syscall.UTF16PtrFromString(strings.ReplaceAll(value, "\n", "\r\n"))
	procSetWindowText.Call(hwnd, uintptr(unsafe.Pointer(text)))
	if hwnd == w.warning {
		show := uintptr(0)
		if value != "" {
			show = 1
		}
		procShowWindow.Call(hwnd, show)
	}
}
