//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/compumark/verselink-telemetry/internal/settings"
)

const (
	wmDestroy    = 0x0002
	wmClose      = 0x0010
	wmCommand    = 0x0111
	wmLButtonUp  = 0x0202
	wmRButtonUp  = 0x0205
	wmApp        = 0x8000
	trayCallback = wmApp + 1
	statusUpdate = wmApp + 2

	nimAdd     = 0x00000000
	nimModify  = 0x00000001
	nimDelete  = 0x00000002
	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	imageIcon      = 1
	lrShared       = 0x00008000
	idiApplication = 32512

	mfString    = 0x00000000
	mfGray      = 0x00000001
	mfSeparator = 0x00000800
	mfByCommand = 0x00000000

	tpmRightButton   = 0x0002
	tpmReturnCommand = 0x0100

	swHide      = 0
	mbOK        = 0x00000000
	mbIconInfo  = 0x00000040
	mbIconError = 0x00000010

	titleMenuID       = 1000
	statusMenuID      = 1001
	diagnosticsMenuID = 1002
	exitMenuID        = 1003
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	shell32                 = syscall.NewLazyDLL("shell32.dll")
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassEx     = user32.NewProc("RegisterClassExW")
	procCreateWindowEx      = user32.NewProc("CreateWindowExW")
	procDefWindowProc       = user32.NewProc("DefWindowProcW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")
	procGetMessage          = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessage     = user32.NewProc("DispatchMessageW")
	procPostMessage         = user32.NewProc("PostMessageW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procCreatePopupMenu     = user32.NewProc("CreatePopupMenu")
	procDestroyMenu         = user32.NewProc("DestroyMenu")
	procAppendMenu          = user32.NewProc("AppendMenuW")
	procModifyMenu          = user32.NewProc("ModifyMenuW")
	procTrackPopupMenu      = user32.NewProc("TrackPopupMenu")
	procGetCursorPos        = user32.NewProc("GetCursorPos")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procLoadImage           = user32.NewProc("LoadImageW")
	procMessageBox          = user32.NewProc("MessageBoxW")
	procShellNotifyIcon     = shell32.NewProc("Shell_NotifyIconW")
	procGetModuleHandle     = kernel32.NewProc("GetModuleHandleW")

	activeTray *windowsTray
)

type point struct {
	X int32
	Y int32
}

type message struct {
	HWnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
	Private uint32
}

type windowClassEx struct {
	Size        uint32
	Style       uint32
	WindowProc  uintptr
	ClassExtra  int32
	WindowExtra int32
	Instance    uintptr
	Icon        uintptr
	Cursor      uintptr
	Background  uintptr
	MenuName    *uint16
	ClassName   *uint16
	SmallIcon   uintptr
}

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

type notifyIconData struct {
	Size             uint32
	HWnd             uintptr
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             uintptr
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	GUID             guid
	BalloonIcon      uintptr
}

type windowsTray struct {
	hwnd            uintptr
	menu            uintptr
	icon            notifyIconData
	store           *statusStore
	onExit          func()
	removed         bool
	settingsStore   settings.Store
	settingsValue   settings.Settings
	settingsWarning string
	settingsWindow  *settingsWindow
}

func newWindowsTray(store *statusStore) (*windowsTray, error) {
	if activeTray != nil {
		return nil, fmt.Errorf("tray is already initialized")
	}
	instance, _, err := procGetModuleHandle.Call(0)
	if instance == 0 {
		return nil, fmt.Errorf("get module handle: %w", err)
	}
	className, _ := syscall.UTF16PtrFromString("VerseLinkTelemetryTrayWindow")
	title, _ := syscall.UTF16PtrFromString("VerseLink Telemetry")
	callback := syscall.NewCallback(windowProcedure)
	class := windowClassEx{
		Size:       uint32(unsafe.Sizeof(windowClassEx{})),
		WindowProc: callback,
		Instance:   instance,
		ClassName:  className,
	}
	atom, _, registerErr := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 {
		return nil, fmt.Errorf("register tray window class: %w", registerErr)
	}
	hwnd, _, createErr := procCreateWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		0,
		0, 0, 0, 0,
		0, 0, instance, 0,
	)
	if hwnd == 0 {
		return nil, fmt.Errorf("create tray window: %w", createErr)
	}
	menu, _, menuErr := procCreatePopupMenu.Call()
	if menu == 0 {
		procDestroyWindow.Call(hwnd)
		return nil, fmt.Errorf("create tray menu: %w", menuErr)
	}
	tray := &windowsTray{hwnd: hwnd, menu: menu, store: store}
	activeTray = tray
	if err := tray.buildMenu(); err != nil {
		tray.cleanup()
		return nil, err
	}
	icon, _, _ := procLoadImage.Call(0, idiApplication, imageIcon, 0, 0, lrShared)
	tray.icon = notifyIconData{
		Size:            uint32(unsafe.Sizeof(notifyIconData{})),
		HWnd:            hwnd,
		ID:              1,
		Flags:           nifMessage | nifIcon | nifTip,
		CallbackMessage: trayCallback,
		Icon:            icon,
	}
	copyUTF16(tray.icon.Tip[:], "VerseLink Telemetry — Starting")
	if result, _, notifyErr := procShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&tray.icon))); result == 0 {
		tray.cleanup()
		return nil, fmt.Errorf("add tray icon: %w", notifyErr)
	}
	procShowWindow.Call(hwnd, swHide)
	return tray, nil
}

func (t *windowsTray) buildMenu() error {
	items := []struct {
		flags uintptr
		id    uintptr
		text  string
	}{
		{mfString | mfGray, titleMenuID, "VerseLink Telemetry"},
		{mfSeparator, 0, ""},
		{mfString | mfGray, statusMenuID, "Status: Starting"},
		{mfString, diagnosticsMenuID, "Open diagnostics"},
		{mfString, settingsMenuID, "Settings..."},
		{mfSeparator, 0, ""},
		{mfString, exitMenuID, "Exit"},
	}
	for _, item := range items {
		var textPointer uintptr
		if item.text != "" {
			value, _ := syscall.UTF16PtrFromString(item.text)
			textPointer = uintptr(unsafe.Pointer(value))
		}
		if result, _, err := procAppendMenu.Call(t.menu, item.flags, item.id, textPointer); result == 0 {
			return fmt.Errorf("append tray menu: %w", err)
		}
	}
	return nil
}

func (t *windowsTray) run() error {
	defer t.cleanup()
	var msg message
	for {
		result, _, err := procGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(result) == -1 {
			return fmt.Errorf("read tray window message: %w", err)
		}
		if result == 0 {
			return nil
		}
		if t.settingsWindow != nil {
			consumed, _, _ := procIsDialogMessage.Call(t.settingsWindow.hwnd, uintptr(unsafe.Pointer(&msg)))
			if consumed != 0 {
				continue
			}
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

func (t *windowsTray) postStatusUpdate() {
	procPostMessage.Call(t.hwnd, statusUpdate, 0, 0)
}

func (t *windowsTray) postClose() {
	procPostMessage.Call(t.hwnd, wmClose, 0, 0)
}

func (t *windowsTray) refreshStatus() {
	text := statusText(t.store.Current())
	if t.settingsWindow != nil {
		t.settingsWindow.refreshSummary()
	}
	menuText, _ := syscall.UTF16PtrFromString("Status: " + text)
	procModifyMenu.Call(t.menu, statusMenuID, mfByCommand|mfString|mfGray, statusMenuID, uintptr(unsafe.Pointer(menuText)))
	copyUTF16(t.icon.Tip[:], "VerseLink Telemetry — "+text)
	t.icon.Flags = nifTip
	procShellNotifyIcon.Call(nimModify, uintptr(unsafe.Pointer(&t.icon)))
}

func (t *windowsTray) showMenu() {
	var cursor point
	if result, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor))); result == 0 {
		return
	}
	procSetForegroundWindow.Call(t.hwnd)
	command, _, _ := procTrackPopupMenu.Call(t.menu, tpmRightButton|tpmReturnCommand, uintptr(cursor.X), uintptr(cursor.Y), 0, t.hwnd, 0)
	t.handleCommand(command)
}

func (t *windowsTray) handleCommand(command uintptr) {
	switch command {
	case diagnosticsMenuID:
		showNativeMessage("VerseLink Telemetry Diagnostics", diagnosticsText(t.store.Current()), mbOK|mbIconInfo)
	case settingsMenuID:
		t.openSettings()
	case exitMenuID:
		if t.onExit != nil {
			t.onExit()
		}
	}
}

func (t *windowsTray) cleanup() {
	if t.settingsWindow != nil {
		procDestroyWindow.Call(t.settingsWindow.hwnd)
		t.settingsWindow = nil
	}
	if !t.removed && t.hwnd != 0 {
		procShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&t.icon)))
		t.removed = true
	}
	if t.menu != 0 {
		procDestroyMenu.Call(t.menu)
		t.menu = 0
	}
	if t.hwnd != 0 {
		procDestroyWindow.Call(t.hwnd)
		t.hwnd = 0
	}
	activeTray = nil
}

func windowProcedure(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	tray := activeTray
	if tray != nil {
		if tray.settingsWindow != nil && tray.settingsWindow.hwnd == hwnd && tray.handleSettingsMessage(hwnd, msg, wParam, lParam) {
			return 0
		}
		switch msg {
		case trayCallback:
			if lParam == wmLButtonUp || lParam == wmRButtonUp {
				tray.showMenu()
			}
			return 0
		case statusUpdate:
			tray.refreshStatus()
			return 0
		case wmCommand:
			tray.handleCommand(wParam & 0xffff)
			return 0
		case wmClose:
			// The shutdown controller posts WM_CLOSE only after the telemetry
			// runtime has stopped. End the loop now; deferred cleanup removes
			// the icon before destroying the hidden window.
			procPostQuitMessage.Call(0)
			return 0
		case wmDestroy:
			procPostQuitMessage.Call(0)
			return 0
		}
	}
	result, _, _ := procDefWindowProc.Call(hwnd, uintptr(msg), wParam, lParam)
	return result
}

func copyUTF16(destination []uint16, value string) {
	encoded, _ := syscall.UTF16FromString(value)
	if len(encoded) > len(destination) {
		encoded = encoded[:len(destination)]
		encoded[len(encoded)-1] = 0
	}
	clear(destination)
	copy(destination, encoded)
}

func showNativeError(message string) {
	showNativeMessage("VerseLink Telemetry", message, mbOK|mbIconError)
}

func showNativeMessage(title, text string, flags uintptr) {
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	textPointer, _ := syscall.UTF16PtrFromString(text)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(textPointer)), uintptr(unsafe.Pointer(titlePointer)), flags)
}
