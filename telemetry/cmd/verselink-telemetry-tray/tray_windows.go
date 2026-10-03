//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/compumark/verselink-telemetry/internal/connection"
	"github.com/compumark/verselink-telemetry/internal/diagnosticsexport"
	"github.com/compumark/verselink-telemetry/internal/revision"
	"github.com/compumark/verselink-telemetry/internal/settings"
	"github.com/compumark/verselink-telemetry/internal/updatecheck"
)

const (
	wmDestroy         = 0x0002
	wmClose           = 0x0010
	wmQueryEndSession = 0x0011
	wmEndSession      = 0x0016
	wmCommand         = 0x0111
	wmLButtonUp       = 0x0202
	wmRButtonUp       = 0x0205
	wmApp             = 0x8000
	trayCallback      = wmApp + 1
	statusUpdate      = wmApp + 2
	liveStatusUpdate  = wmApp + 3
	pairingComplete   = wmApp + 4
	closeAfterPairing = wmApp + 5
	updateCheckDone   = wmApp + 6

	nimAdd     = 0x00000000
	nimModify  = 0x00000001
	nimDelete  = 0x00000002
	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004
	nifInfo    = 0x00000010

	niifInfo = 0x00000001

	imageIcon       = 1
	lrShared        = 0x00008000
	lrDefaultSize   = 0x00000040
	appIconResource = 1

	mfString    = 0x00000000
	mfGray      = 0x00000001
	mfSeparator = 0x00000800
	mfByCommand = 0x00000000

	tpmRightButton   = 0x0002
	tpmReturnCommand = 0x0100

	swHide      = 0
	swRestore   = 9
	mbOK        = 0x00000000
	mbIconInfo  = 0x00000040
	mbIconError = 0x00000010
	mbYesNo     = 0x00000004
	mbIconWarn  = 0x00000030
	idYes       = 6

	titleMenuID       = 1000
	statusMenuID      = 1001
	diagnosticsMenuID = 1002
	exitMenuID        = 1003
	liveMonitorMenuID = 1005
	exportMenuID      = 1006
	viewReleaseMenuID = 1007
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
	procGetFocus            = user32.NewProc("GetFocus")
	procIsChild             = user32.NewProc("IsChild")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procShellNotifyIcon     = shell32.NewProc("Shell_NotifyIconW")
	procShellExecute        = shell32.NewProc("ShellExecuteW")
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
	hwnd                    uintptr
	menu                    uintptr
	icon                    notifyIconData
	store                   *statusStore
	onExit                  func()
	shuttingDown            bool
	updateIndicator         updateIndicator
	updateResults           chan updatecheck.Result
	updatePostMu            sync.Mutex
	updatePostClosed        bool
	workerGroup             *sync.WaitGroup
	autostart               autostartManager
	removed                 bool
	settingsStore           settings.Store
	settingsValue           settings.Settings
	settingsWarning         string
	settingsWindow          *settingsWindow
	liveWindow              *liveMonitorWindow
	credentialStore         connection.CredentialStore
	connectionState         connection.State
	connectionMessage       string
	heartbeatUpdates        chan connection.HeartbeatConfig
	heartbeatConfig         connection.HeartbeatConfig
	presenceUpdates         chan connection.PresenceConfig
	presenceConfig          connection.PresenceConfig
	locationCatalogUpdates  chan connection.LocationCatalogConfig
	locationCatalogConfig   connection.LocationCatalogConfig
	revisionLock            *revision.Lock
	revisionLockUnavailable bool
	revisionDirectory       string
	pairingResults          chan pairingResult
	pairingDone             chan struct{}
	pairingCancel           context.CancelFunc
	pairingActive           bool
	pairingPostGate         pairingPostGate
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
	tray := &windowsTray{hwnd: hwnd, menu: menu, store: store, updateResults: make(chan updatecheck.Result, 1)}
	activeTray = tray
	if err := tray.buildMenu(); err != nil {
		tray.cleanup()
		return nil, err
	}
	icon, _, iconErr := procLoadImage.Call(instance, appIconResource, imageIcon, 0, 0, lrDefaultSize|lrShared)
	if icon == 0 {
		tray.cleanup()
		return nil, fmt.Errorf("load VerseLink tray icon resource: %w", iconErr)
	}
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
		{mfString, liveMonitorMenuID, "Open live telemetry"},
		{mfString, diagnosticsMenuID, "Open diagnostics"},
		{mfString, exportMenuID, "Export troubleshooting package..."},
		{mfString, settingsMenuID, "Settings..."},
		{mfString, viewReleaseMenuID, "View release"},
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
	var msg message
	for {
		result, _, err := procGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(result) == -1 {
			return fmt.Errorf("read tray window message: %w", err)
		}
		if result == 0 {
			return nil
		}
		if t.preprocessDialogMessage(uintptr(unsafe.Pointer(&msg))) {
			continue
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

func (t *windowsTray) preprocessDialogMessage(msg uintptr) bool {
	focus, _, _ := procGetFocus.Call()
	for _, hwnd := range []uintptr{windowHandle(t.liveWindow), windowHandle(t.settingsWindow)} {
		visible, _, _ := procIsWindowVisible.Call(hwnd)
		child, _, _ := procIsChild.Call(hwnd, focus)
		if hwnd == 0 || visible == 0 || (focus != hwnd && child == 0) {
			continue
		}
		consumed, _, _ := procIsDialogMessage.Call(hwnd, msg)
		return consumed != 0
	}
	return false
}

func windowHandle(window interface{ handle() uintptr }) uintptr {
	if window == nil {
		return 0
	}
	return window.handle()
}

func (t *windowsTray) postStatusUpdate() {
	procPostMessage.Call(t.hwnd, statusUpdate, 0, 0)
}

func (t *windowsTray) postLiveStatusUpdate() {
	procPostMessage.Call(t.hwnd, liveStatusUpdate, 0, 0)
}

func (t *windowsTray) postUpdateCheckResult(result updatecheck.Result) {
	if t == nil || !result.HasUpdate() {
		return
	}
	t.updatePostMu.Lock()
	defer t.updatePostMu.Unlock()
	if t.updatePostClosed || t.hwnd == 0 {
		return
	}
	select {
	case t.updateResults <- result:
	default:
		return
	}
	if posted, _, _ := procPostMessage.Call(t.hwnd, updateCheckDone, 0, 0); posted == 0 {
		select {
		case <-t.updateResults:
		default:
		}
	}
}

func (t *windowsTray) publishHeartbeatConfig(value connection.HeartbeatConfig) {
	if t == nil || t.heartbeatUpdates == nil {
		return
	}
	select {
	case t.heartbeatUpdates <- value:
		return
	default:
	}
	select {
	case <-t.heartbeatUpdates:
	default:
	}
	select {
	case t.heartbeatUpdates <- value:
	default:
	}
}

func (t *windowsTray) publishPresenceConfig(value connection.PresenceConfig) {
	if t == nil || t.presenceUpdates == nil {
		return
	}
	select {
	case t.presenceUpdates <- value:
		return
	default:
	}
	select {
	case <-t.presenceUpdates:
	default:
	}
	select {
	case t.presenceUpdates <- value:
	default:
	}
}

func (t *windowsTray) publishLocationCatalogConfig(value connection.LocationCatalogConfig) {
	if t == nil || t.locationCatalogUpdates == nil {
		return
	}
	select {
	case t.locationCatalogUpdates <- value:
		return
	default:
	}
	select {
	case <-t.locationCatalogUpdates:
	default:
	}
	select {
	case t.locationCatalogUpdates <- value:
	default:
	}
}

func (t *windowsTray) postClose() {
	procPostMessage.Call(t.hwnd, wmClose, 0, 0)
}

func (t *windowsTray) refreshStatus() {
	text := statusText(t.store.Current())
	health := t.store.CurrentHealth()
	switch health.State {
	case connection.HealthNotConnected:
		t.connectionState = connection.NotConnected
	case connection.HealthConnecting:
		t.connectionState = connection.Connecting
	case connection.HealthConnected:
		t.connectionState = connection.Connected
	case connection.HealthTemporarilyOffline:
		t.connectionState = connection.TemporarilyOffline
	case connection.HealthAuthenticationFailed:
		t.connectionState = connection.AuthenticationFailed
	case connection.HealthDeviceRevoked:
		t.connectionState = connection.DeviceRevoked
	}
	if health.State != "" {
		t.connectionMessage = health.Error
		if !health.LastSuccess.IsZero() {
			t.connectionMessage = "Last successful heartbeat: " + health.LastSuccess.UTC().Format(time.RFC3339)
			if health.Error != "" {
				t.connectionMessage += " — " + health.Error
			}
		}
	}
	if t.settingsWindow != nil {
		t.settingsWindow.refreshSummary()
		t.settingsWindow.refreshConnection()
	}
	connectionText := string(t.connectionState)
	if connectionText == "" {
		connectionText = "Not connected"
	}
	menuText, _ := syscall.UTF16PtrFromString("Connection: " + connectionText + " | " + text)
	procModifyMenu.Call(t.menu, statusMenuID, mfByCommand|mfString|mfGray, statusMenuID, uintptr(unsafe.Pointer(menuText)))
	tip := "VerseLink — " + connectionText + " — " + text
	if updateTip := t.updateIndicator.tooltip(); updateTip != "" {
		tip = updateTip
	}
	copyUTF16(t.icon.Tip[:], tip)
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
	if t.shuttingDown && command != exitMenuID {
		return
	}
	switch command {
	case diagnosticsMenuID:
		showNativeMessage("VerseLink Telemetry Diagnostics", diagnosticsTextWithLifecycle(t.store.Current(), t.store.LifecycleEvents()), mbOK|mbIconInfo)
	case exportMenuID:
		t.exportDiagnostics()
	case liveMonitorMenuID:
		t.openLiveMonitor()
	case settingsMenuID:
		t.openSettings()
	case viewReleaseMenuID:
		t.openReleasePage()
	case exitMenuID:
		if t.onExit != nil {
			t.onExit()
		}
	}
}

func (t *windowsTray) openReleasePage() {
	verb, _ := syscall.UTF16PtrFromString("open")
	url, _ := syscall.UTF16PtrFromString(releasePageURL)
	result, _, _ := procShellExecute.Call(t.hwnd, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(url)), 0, 0, 1)
	if result <= 32 {
		showNativeError("Could not open the VerseLink Releases page.")
	}
}

func (t *windowsTray) showUpdateNotification(result updatecheck.Result) {
	if t.shuttingDown || !t.updateIndicator.apply(result) {
		return
	}
	t.refreshStatus()
	copyUTF16(t.icon.InfoTitle[:], "VerseLink Telemetry")
	copyUTF16(t.icon.Info[:], t.updateIndicator.notificationText())
	t.icon.InfoFlags = niifInfo
	t.icon.Flags = nifTip | nifInfo
	procShellNotifyIcon.Call(nimModify, uintptr(unsafe.Pointer(&t.icon)))
	t.icon.Flags = nifTip
}

func (t *windowsTray) exportDiagnostics() {
	const explanation = "This local JSON package includes app/build information, coarse runtime and connection status, aggregate counters, up to 12 lifecycle codes, and up to 24 application-log records (time, severity, fixed event code; at most 4 KiB). It excludes Game.log paths and contents, player/ship/Party names, identifiers, credentials, tokens, pairing codes, and raw errors. Nothing is uploaded. Continue to choose a save location?"
	if showNativeQuestion(t.hwnd, "Export troubleshooting package", explanation) != idYes {
		return
	}
	path, selected, err := saveDiagnosticsPath(t.hwnd)
	if err != nil {
		showNativeError("Could not open the export file dialog. No package was written.")
		return
	}
	if !selected {
		return
	}
	status := t.store.Current()
	data, err := diagnosticsexport.Marshal(diagnosticsexport.Snapshot{
		Status: status, Health: t.store.CurrentHealth(), Lifecycle: t.store.LifecycleEvents(),
		ApplicationLogs: t.store.ApplicationLogs(),
	})
	if err != nil {
		showNativeError("Could not create the diagnostics package. No file was written.")
		return
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		showNativeError("Could not save the diagnostics package. Check the selected folder and permissions.")
		return
	}
	showNativeMessageFor(t.hwnd, "Diagnostics exported", "A bounded diagnostics package was saved locally as "+filepath.Base(path)+". It was not uploaded.", mbOK|mbIconInfo)
}

func (t *windowsTray) beginShutdown() {
	if t == nil || t.shuttingDown {
		return
	}
	t.updatePostMu.Lock()
	t.updatePostClosed = true
	t.updatePostMu.Unlock()
	t.shuttingDown = true
	t.cancelPairing()
	if t.hwnd != 0 {
		procEnableWindow.Call(t.hwnd, 0)
	}
	if t.settingsWindow != nil {
		procEnableWindow.Call(t.settingsWindow.hwnd, 0)
	}
	if t.liveWindow != nil {
		procEnableWindow.Call(t.liveWindow.hwnd, 0)
	}
}

func (t *windowsTray) cleanup() {
	t.updatePostMu.Lock()
	t.updatePostClosed = true
	t.updatePostMu.Unlock()
	if t.revisionLock != nil {
		_ = t.revisionLock.Release()
		t.revisionLock = nil
	}
	if t.liveWindow != nil {
		procDestroyWindow.Call(t.liveWindow.hwnd)
		t.liveWindow = nil
	}
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
		if tray.liveWindow != nil && tray.liveWindow.hwnd == hwnd && tray.handleLiveMonitorMessage(hwnd, msg, wParam, lParam) {
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
		case liveStatusUpdate:
			tray.refreshLiveMonitor()
			return 0
		case updateCheckDone:
			if !tray.shuttingDown {
				select {
				case result := <-tray.updateResults:
					tray.showUpdateNotification(result)
				default:
				}
			}
			return 0
		case pairingComplete:
			tray.finishPairing()
			return 0
		case closeAfterPairing:
			tray.postClose()
			return 0
		case wmCommand:
			tray.handleCommand(wParam & 0xffff)
			return 0
		case wmQueryEndSession:
			// Windows may still cancel the session end after this affirmative,
			// non-mutating response. Actual shutdown begins only on WM_ENDSESSION.
			return respondToSessionQuery()
		case wmEndSession:
			handleSessionEnd(wParam != 0, tray.onExit)
			return 0
		case wmClose:
			// The shutdown controller posts WM_CLOSE only after the telemetry
			// runtime has stopped. The caller then performs cleanup on this OS thread.
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
	showNativeMessageFor(0, title, text, flags)
}

func showNativeMessageFor(owner uintptr, title, text string, flags uintptr) {
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	textPointer, _ := syscall.UTF16PtrFromString(text)
	procMessageBox.Call(owner, uintptr(unsafe.Pointer(textPointer)), uintptr(unsafe.Pointer(titlePointer)), flags)
}
