//go:build windows

package connection

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	credTypeGeneric         = 1
	credPersistLocalMachine = 2
)

var advapi = syscall.NewLazyDLL("advapi32.dll")
var (
	procCredWrite  = advapi.NewProc("CredWriteW")
	procCredRead   = advapi.NewProc("CredReadW")
	procCredDelete = advapi.NewProc("CredDeleteW")
	procCredFree   = advapi.NewProc("CredFree")
)

type winFileTime struct{ Low, High uint32 }
type winCredential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        winFileTime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

type credentialAPI interface {
	write(string, []byte) error
	read(string) ([]byte, error)
	delete(string) error
}
type nativeCredentialAPI struct{}
type SystemCredentialStore struct{ api credentialAPI }

func (s SystemCredentialStore) backend() credentialAPI {
	if s.api != nil {
		return s.api
	}
	return nativeCredentialAPI{}
}
func (s SystemCredentialStore) Write(target string, secret []byte) error {
	if target == "" || !validCredential(secret) {
		return errors.New("invalid secure credential input")
	}
	if err := s.backend().write(target, secret); err != nil {
		return errors.New("Windows Credential Manager write failed")
	}
	return nil
}

func (nativeCredentialAPI) write(target string, secret []byte) error {
	name, _ := syscall.UTF16PtrFromString(target)
	user, _ := syscall.UTF16PtrFromString("VerseLink Telemetry")
	entry := winCredential{Type: credTypeGeneric, TargetName: name, CredentialBlobSize: uint32(len(secret)), CredentialBlob: &secret[0], Persist: credPersistLocalMachine, UserName: user}
	result, _, _ := procCredWrite.Call(uintptr(unsafe.Pointer(&entry)), 0)
	if result == 0 {
		return windowsCredError("write")
	}
	return nil
}

func (s SystemCredentialStore) Read(target string) ([]byte, error) {
	if target == "" {
		return nil, errors.New("invalid secure credential target")
	}
	value, err := s.backend().read(target)
	if err != nil {
		return nil, errors.New("Windows Credential Manager read failed")
	}
	return value, nil
}
func (nativeCredentialAPI) read(target string) ([]byte, error) {
	if target == "" {
		return nil, errors.New("invalid secure credential target")
	}
	name, _ := syscall.UTF16PtrFromString(target)
	var entry *winCredential
	result, _, err := procCredRead.Call(uintptr(unsafe.Pointer(name)), credTypeGeneric, 0, uintptr(unsafe.Pointer(&entry)))
	if result == 0 {
		if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_NOT_FOUND {
			return nil, nil
		}
		return nil, windowsCredError("read")
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(entry)))
	if entry == nil || entry.CredentialBlobSize == 0 || entry.CredentialBlobSize > 5120 {
		return nil, errors.New("invalid secure credential record")
	}
	secret := append([]byte(nil), unsafe.Slice(entry.CredentialBlob, int(entry.CredentialBlobSize))...)
	if !validCredential(secret) {
		clear(secret)
		return nil, errors.New("invalid secure credential record")
	}
	return secret, nil
}

func (s SystemCredentialStore) Delete(target string) error {
	if target == "" {
		return errors.New("invalid secure credential target")
	}
	if err := s.backend().delete(target); err != nil {
		return errors.New("Windows Credential Manager delete failed")
	}
	return nil
}
func (nativeCredentialAPI) delete(target string) error {
	if target == "" {
		return errors.New("invalid secure credential target")
	}
	name, _ := syscall.UTF16PtrFromString(target)
	result, _, err := procCredDelete.Call(uintptr(unsafe.Pointer(name)), credTypeGeneric, 0)
	if result == 0 {
		if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_NOT_FOUND {
			return nil
		}
		return windowsCredError("delete")
	}
	return nil
}

func windowsCredError(operation string) error {
	// Credential APIs can expose only operation and numeric OS status, never input values.
	if errno, ok := syscall.GetLastError().(syscall.Errno); ok && errno != 0 {
		return fmt.Errorf("Windows Credential Manager %s failed (error %d)", operation, uint32(errno))
	}
	return fmt.Errorf("Windows Credential Manager %s failed", operation)
}
