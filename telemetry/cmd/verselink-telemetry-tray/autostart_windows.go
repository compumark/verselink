//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	currentUserRunKey  = `Software\Microsoft\Windows\CurrentVersion\Run`
	autostartValueName = "VerseLinkTelemetry"
	registryQueryValue = 0x0001
	registrySetValue   = 0x0002
	registry64View     = 0x0100
	registryString     = 1
	registryNotFound   = 2
	registryMoreData   = 234
	mutexAlreadyExists = 183
	tokenUserClass     = 1
)

var (
	advapi32                   = syscall.NewLazyDLL("advapi32.dll")
	kernel32Lifecycle          = syscall.NewLazyDLL("kernel32.dll")
	procRegOpenKeyExW          = advapi32.NewProc("RegOpenKeyExW")
	procRegCreateKeyExW        = advapi32.NewProc("RegCreateKeyExW")
	procRegQueryValueExW       = advapi32.NewProc("RegQueryValueExW")
	procRegSetValueExW         = advapi32.NewProc("RegSetValueExW")
	procRegDeleteValueW        = advapi32.NewProc("RegDeleteValueW")
	procRegDeleteKeyW          = advapi32.NewProc("RegDeleteKeyW")
	procRegCloseKey            = advapi32.NewProc("RegCloseKey")
	procOpenProcessToken       = advapi32.NewProc("OpenProcessToken")
	procGetTokenInformation    = advapi32.NewProc("GetTokenInformation")
	procConvertSidToStringSidW = advapi32.NewProc("ConvertSidToStringSidW")
	procCreateMutexW           = kernel32Lifecycle.NewProc("CreateMutexW")
	procReleaseMutex           = kernel32Lifecycle.NewProc("ReleaseMutex")
	procCloseHandle            = kernel32Lifecycle.NewProc("CloseHandle")
	procGetCurrentProcess      = kernel32Lifecycle.NewProc("GetCurrentProcess")
	procLocalFree              = kernel32Lifecycle.NewProc("LocalFree")
	procOutputDebugStringW     = kernel32Lifecycle.NewProc("OutputDebugStringW")
)

type nativeRunValueStore struct {
	keyPath   string
	valueName string
}

func (s nativeRunValueStore) path() string {
	if s.keyPath != "" {
		return s.keyPath
	}
	return currentUserRunKey
}

func (s nativeRunValueStore) name() string {
	if s.valueName != "" {
		return s.valueName
	}
	return autostartValueName
}

func (s nativeRunValueStore) read() (string, bool, error) {
	key, err := openRunKeyAt(s.path(), registryQueryValue)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && errno == registryNotFound {
			return "", false, nil
		}
		return "", false, err
	}
	defer procRegCloseKey.Call(uintptr(key))
	name, _ := syscall.UTF16PtrFromString(s.name())
	var valueType uint32
	var size uint32
	result, _, _ := procRegQueryValueExW.Call(uintptr(key), uintptr(unsafe.Pointer(name)), 0, uintptr(unsafe.Pointer(&valueType)), 0, uintptr(unsafe.Pointer(&size)))
	if result == registryNotFound {
		return "", false, nil
	}
	if result != 0 {
		return "", false, syscall.Errno(result)
	}
	if size < 2 || size > 64*1024 {
		return "", true, nil
	}
	data := make([]uint16, (size+1)/2)
	result, _, _ = procRegQueryValueExW.Call(uintptr(key), uintptr(unsafe.Pointer(name)), 0, uintptr(unsafe.Pointer(&valueType)), uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&size)))
	if result == registryMoreData {
		return "", true, nil
	}
	if result != 0 {
		return "", false, syscall.Errno(result)
	}
	if valueType != registryString {
		return "", true, nil
	}
	return syscall.UTF16ToString(data), true, nil
}

func (s nativeRunValueStore) write(value string) error {
	key, err := openOrCreateRunKeyAt(s.path(), registrySetValue)
	if err != nil {
		return err
	}
	defer procRegCloseKey.Call(uintptr(key))
	name, _ := syscall.UTF16PtrFromString(s.name())
	data, err := syscall.UTF16FromString(value)
	if err != nil {
		return err
	}
	result, _, _ := procRegSetValueExW.Call(uintptr(key), uintptr(unsafe.Pointer(name)), 0, registryString, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}

func (s nativeRunValueStore) delete() error {
	key, err := openRunKeyAt(s.path(), registrySetValue)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && errno == registryNotFound {
			return nil
		}
		return err
	}
	defer procRegCloseKey.Call(uintptr(key))
	name, _ := syscall.UTF16PtrFromString(s.name())
	result, _, _ := procRegDeleteValueW.Call(uintptr(key), uintptr(unsafe.Pointer(name)))
	if result == registryNotFound {
		return nil
	}
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}

func openRunKey(access uintptr) (syscall.Handle, error) {
	return openRunKeyAt(currentUserRunKey, access)
}

func openRunKeyAt(keyPath string, access uintptr) (syscall.Handle, error) {
	path, _ := syscall.UTF16PtrFromString(keyPath)
	var key syscall.Handle
	result, _, _ := procRegOpenKeyExW.Call(uintptr(0x80000001), uintptr(unsafe.Pointer(path)), 0, access|registry64View, uintptr(unsafe.Pointer(&key)))
	if result != 0 {
		return 0, syscall.Errno(result)
	}
	return key, nil
}

func openOrCreateRunKey(access uintptr) (syscall.Handle, error) {
	return openOrCreateRunKeyAt(currentUserRunKey, access)
}

func openOrCreateRunKeyAt(keyPath string, access uintptr) (syscall.Handle, error) {
	path, _ := syscall.UTF16PtrFromString(keyPath)
	var key syscall.Handle
	result, _, _ := procRegCreateKeyExW.Call(uintptr(0x80000001), uintptr(unsafe.Pointer(path)), 0, 0, 0, access|registry64View, 0, uintptr(unsafe.Pointer(&key)), 0)
	if result != 0 {
		return 0, syscall.Errno(result)
	}
	return key, nil
}

func deleteRunKeyForTest(keyPath string) error {
	path, _ := syscall.UTF16PtrFromString(keyPath)
	result, _, _ := procRegDeleteKeyW.Call(uintptr(0x80000001), uintptr(unsafe.Pointer(path)))
	if result == registryNotFound {
		return nil
	}
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}

func currentExecutablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable path: %w", err)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("make executable path absolute: %w", err)
	}
	return filepath.Clean(path), nil
}

type tokenUser struct {
	SID        *byte
	Attributes uint32
}

func currentUserSID() (string, error) {
	process, _, _ := procGetCurrentProcess.Call()
	var token syscall.Handle
	result, _, callErr := procOpenProcessToken.Call(process, 0x0008, uintptr(unsafe.Pointer(&token)))
	if result == 0 {
		return "", fmt.Errorf("open current process token: %w", callErr)
	}
	defer procCloseHandle.Call(uintptr(token))
	var required uint32
	procGetTokenInformation.Call(uintptr(token), tokenUserClass, 0, 0, uintptr(unsafe.Pointer(&required)))
	if required == 0 {
		return "", fmt.Errorf("query current user token size: %w", syscall.GetLastError())
	}
	buffer := make([]byte, required)
	result, _, callErr = procGetTokenInformation.Call(uintptr(token), tokenUserClass, uintptr(unsafe.Pointer(&buffer[0])), uintptr(required), uintptr(unsafe.Pointer(&required)))
	if result == 0 {
		return "", fmt.Errorf("read current user token: %w", callErr)
	}
	user := (*tokenUser)(unsafe.Pointer(&buffer[0]))
	var sidText *uint16
	result, _, callErr = procConvertSidToStringSidW.Call(uintptr(unsafe.Pointer(user.SID)), uintptr(unsafe.Pointer(&sidText)))
	if result == 0 {
		return "", fmt.Errorf("convert current user SID: %w", callErr)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(sidText)))
	return syscall.UTF16ToString((*[1 << 15]uint16)(unsafe.Pointer(sidText))[:]), nil
}

func acquireApplicationMutex() (release func(), alreadyRunning bool, err error) {
	sid, err := currentUserSID()
	if err != nil {
		return nil, false, err
	}
	return acquireNamedApplicationMutex(`Local\VerseLinkTelemetry-v1-` + sid)
}

func acquireNamedApplicationMutex(value string) (release func(), alreadyRunning bool, err error) {
	name, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		return nil, false, err
	}
	handle, _, callErr := procCreateMutexW.Call(0, 1, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return nil, false, fmt.Errorf("create application mutex: %w", callErr)
	}
	if errno, ok := callErr.(syscall.Errno); ok && errno == mutexAlreadyExists {
		procCloseHandle.Call(handle)
		return nil, true, nil
	}
	return func() {
		procReleaseMutex.Call(handle)
		procCloseHandle.Call(handle)
	}, false, nil
}

func emitLifecycleDebug(event string) {
	text, _ := syscall.UTF16PtrFromString("VerseLink Telemetry lifecycle: " + event)
	procOutputDebugStringW.Call(uintptr(unsafe.Pointer(text)))
}
