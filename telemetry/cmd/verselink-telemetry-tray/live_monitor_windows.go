//go:build windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

const (
	liveCopyID    = 1301
	cfUnicodeText = 13
	ghnd          = 0x0042
	gmemZeroInit  = 0x0040
)

var (
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procSetClipboardData = user32.NewProc("SetClipboardData")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	procGlobalFree       = kernel32.NewProc("GlobalFree")
	procRtlMoveMemory    = kernel32.NewProc("RtlMoveMemory")
	procSetLastError     = kernel32.NewProc("SetLastError")
)

type liveMonitorWindow struct {
	hwnd        uintptr
	font        uintptr
	values      []uintptr
	copyStatus  uintptr
	focusTarget uintptr
}

func (w *liveMonitorWindow) handle() uintptr {
	if w == nil {
		return 0
	}
	return w.hwnd
}

func (t *windowsTray) openLiveMonitor() {
	if t.liveWindow != nil {
		procShowWindow.Call(t.liveWindow.hwnd, swRestore)
		procSetForeground.Call(t.liveWindow.hwnd)
		t.store.SetLiveVisible(true)
		t.refreshLiveMonitor()
		return
	}
	window, err := createLiveMonitorWindow()
	if err != nil {
		showNativeError(fmt.Sprintf("Could not open live monitor:\n\n%v", err))
		return
	}
	t.liveWindow = window
	t.store.SetLiveVisible(true)
	procSetForeground.Call(window.hwnd)
	procSetFocus.Call(window.focusTarget)
	t.refreshLiveMonitor()
}

func createLiveMonitorWindow() (*liveMonitorWindow, error) {
	style, exStyle := uintptr(wsCaption|wsSysMenu), uintptr(wsExToolWindow)
	dpi := uint32(96)
	if got, _, _ := procGetDpiForSystem.Call(); got != 0 {
		dpi = uint32(got)
	}
	scale := func(v int32) int32 { return int32((int64(v)*int64(dpi) + 48) / 96) }
	client := settingsWindowRect{Right: scale(760), Bottom: scale(690)}
	if result, _, adjustErr := procAdjustWindowRect.Call(uintptr(unsafe.Pointer(&client)), style, 0, exStyle); result == 0 {
		return nil, windowsCallError("adjust live monitor window bounds", adjustErr)
	}
	instance, _, instanceErr := procGetModuleHandle.Call(0)
	if instance == 0 {
		return nil, windowsCallError("get application module handle", instanceErr)
	}
	className := mustUTF16("VerseLinkTelemetryTrayWindow")
	title := mustUTF16("VerseLink Telemetry — Live")
	hwnd, _, createErr := procCreateWindowEx.Call(exStyle, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), style, 0x80000000, 0x80000000, uintptr(client.Right-client.Left), uintptr(client.Bottom-client.Top), 0, 0, instance, 0)
	if hwnd == 0 {
		return nil, windowsCallError("create live monitor window", createErr)
	}
	window := &liveMonitorWindow{hwnd: hwnd}
	if activeTray != nil {
		activeTray.liveWindow = window
	}
	fontHeight := -int32((9*int(dpi) + 36) / 72)
	font, _, fontErr := procCreateFont.Call(uintptr(fontHeight), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(mustUTF16("Segoe UI"))))
	if font == 0 {
		procDestroyWindow.Call(hwnd)
		return nil, windowsCallError("create live monitor font", fontErr)
	}
	window.font = font
	var controlCreationErr error
	add := func(class, text string, style uintptr, x, y, width, height int32, id uintptr) uintptr {
		control, err := createSettingsControl(hwnd, class, text, style|wsChild|wsVisible, scale(x), scale(y), scale(width), scale(height), instance, id)
		if err != nil {
			controlCreationErr = err
			return 0
		}
		procSendMessage.Call(control, wmSetFont, font, 1)
		return control
	}
	add("BUTTON", "Source", bsGroupBox, 12, 10, 736, 194, 0)
	add("BUTTON", "Session", bsGroupBox, 12, 210, 736, 130, 0)
	add("BUTTON", "Location", bsGroupBox, 12, 346, 736, 94, 0)
	add("BUTTON", "Ship", bsGroupBox, 12, 446, 360, 96, 0)
	add("BUTTON", "Quantum Travel", bsGroupBox, 380, 446, 368, 96, 0)
	add("BUTTON", "Party", bsGroupBox, 12, 548, 736, 64, 0)
	labels := []struct {
		text    string
		x, y, w int32
	}{
		{"Status:", 20, 34, 126}, {"Channel:", 20, 56, 126}, {"Discovery:", 20, 78, 126}, {"Game.log:", 20, 100, 126},
		{"Lines processed:", 20, 146, 126}, {"Parser events:", 20, 164, 126}, {"Source resets:", 20, 182, 126},
		{"Session:", 20, 234, 126}, {"Player:", 20, 258, 126}, {"Shard:", 20, 282, 126}, {"Last event:", 20, 306, 126},
		{"Location:", 20, 368, 126}, {"Observed:", 20, 392, 126}, {"Jurisdiction:", 20, 416, 126},
		{"Ship:", 20, 470, 80}, {"Owner:", 20, 500, 80}, {"Destination:", 388, 470, 112}, {"QT state:", 388, 500, 112},
		{"Members:", 20, 574, 126},
	}
	for _, item := range labels {
		add("STATIC", item.text, ssLeft, item.x, item.y, item.w, 20, 0)
	}
	window.values = make([]uintptr, 19)
	positions := [][4]int32{{150, 34, 580, 20}, {150, 56, 580, 20}, {150, 78, 580, 20}, {150, 100, 580, 42}, {150, 146, 580, 20}, {150, 164, 580, 20}, {150, 182, 580, 20}, {150, 234, 580, 20}, {150, 258, 580, 20}, {150, 282, 580, 20}, {150, 306, 580, 20}, {150, 368, 580, 20}, {150, 392, 580, 20}, {150, 416, 580, 20}, {104, 470, 250, 20}, {104, 500, 250, 20}, {504, 470, 232, 20}, {504, 500, 232, 20}, {150, 574, 580, 20}}
	for i, position := range positions {
		style := uintptr(ssLeft | ssNoPrefix)
		if i == 3 {
			style |= ssEditControl
		}
		window.values[i] = add("STATIC", "Unknown", style, position[0], position[1], position[2], position[3], 0)
		if window.values[i] == 0 {
			procDestroyWindow.Call(hwnd)
			return nil, fmt.Errorf("create live monitor control %d", i)
		}
	}
	window.copyStatus = add("STATIC", "", ssLeftNoWrap, 20, 630, 500, 20, 0)
	window.focusTarget = add("BUTTON", "Copy current status", wsTabStop, 524, 652, 128, 28, liveCopyID)
	add("BUTTON", "Close", wsTabStop|bsDefaultButton, 660, 652, 76, 28, dialogCancelID)
	if controlCreationErr != nil {
		procDestroyWindow.Call(hwnd)
		return nil, controlCreationErr
	}
	procShowWindow.Call(hwnd, swShow)
	return window, nil
}

func (t *windowsTray) refreshLiveMonitor() {
	if t.liveWindow == nil {
		return
	}
	if visible, _, _ := procIsWindowVisible.Call(t.liveWindow.hwnd); visible == 0 {
		return
	}
	p := t.store.CurrentLivePresentation()
	values := []string{p.status, p.channel, p.strategy, p.path, p.lines, p.events, p.resets, p.session, p.player, p.shard, p.lastEvent, p.location, p.locationAt, p.zone, p.ship, p.owner, p.quantumDestination, p.quantumState, p.partyCount}
	for i, value := range values {
		setNativeText(t.liveWindow.values[i], value)
	}
}

func (t *windowsTray) handleLiveMonitorMessage(hwnd uintptr, msg uint32, wParam, lParam uintptr) bool {
	w := t.liveWindow
	if w == nil || w.hwnd != hwnd {
		return false
	}
	switch msg {
	case wmClose:
		t.store.SetLiveVisible(false)
		procShowWindow.Call(hwnd, swHide)
		return true
	case wmDestroy:
		t.store.SetLiveVisible(false)
		if w.font != 0 {
			procDeleteObject.Call(w.font)
			w.font = 0
		}
		t.liveWindow = nil
		return true
	case wmCommand:
		if wParam>>16 != bnClicked {
			return true
		}
		switch wParam & 0xffff {
		case liveCopyID:
			if err := copyUnicodeText(hwnd, formatLiveTelemetry(t.store.CurrentLivePresentation())); err != nil {
				setNativeText(w.copyStatus, "Copy failed: clipboard is unavailable.")
			} else {
				setNativeText(w.copyStatus, "Current privacy-safe status copied.")
			}
		case dialogCancelID:
			t.store.SetLiveVisible(false)
			procShowWindow.Call(hwnd, swHide)
		}
		return true
	}
	return false
}

func setNativeText(hwnd uintptr, value string) {
	text, _ := syscall.UTF16PtrFromString(value)
	procSetWindowText.Call(hwnd, uintptr(unsafe.Pointer(text)))
}

func copyUnicodeText(owner uintptr, value string) error {
	text, err := syscall.UTF16FromString(value)
	if err != nil {
		return err
	}
	size := uintptr(len(text) * 2)
	handle, _, allocErr := procGlobalAlloc.Call(ghnd|gmemZeroInit, size)
	if handle == 0 {
		return windowsCallError("allocate clipboard text", allocErr)
	}
	locked, _, lockErr := procGlobalLock.Call(handle)
	if locked == 0 {
		return errors.Join(windowsCallError("lock clipboard text", lockErr), freeClipboardMemory(handle))
	}
	procRtlMoveMemory.Call(locked, uintptr(unsafe.Pointer(&text[0])), size)
	runtime.KeepAlive(text)
	procSetLastError.Call(0)
	if unlocked, _, unlockErr := procGlobalUnlock.Call(handle); unlocked == 0 && unlockErr != syscall.Errno(0) {
		return errors.Join(windowsCallError("unlock clipboard text", unlockErr), freeClipboardMemory(handle))
	}
	if result, _, openErr := procOpenClipboard.Call(owner); result == 0 {
		return errors.Join(windowsCallError("open clipboard", openErr), freeClipboardMemory(handle))
	}
	if result, _, emptyErr := procEmptyClipboard.Call(); result == 0 {
		return errors.Join(windowsCallError("empty clipboard", emptyErr), freeClipboardMemory(handle), closeClipboard())
	}
	if result, _, setErr := procSetClipboardData.Call(cfUnicodeText, handle); result == 0 {
		return errors.Join(windowsCallError("set clipboard text", setErr), freeClipboardMemory(handle), closeClipboard())
	}
	return closeClipboard()
}

func freeClipboardMemory(handle uintptr) error {
	if result, _, err := procGlobalFree.Call(handle); result != 0 {
		return windowsCallError("free clipboard text", err)
	}
	return nil
}

func closeClipboard() error {
	if result, _, err := procCloseClipboard.Call(); result == 0 {
		return windowsCallError("close clipboard", err)
	}
	return nil
}
