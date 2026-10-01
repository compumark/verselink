//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	ofnoverwriteprompt = 0x00000002
	ofnpathmustexist   = 0x00000800
	ofnhideReadOnly    = 0x00000004
	ofnnochangedir     = 0x00000008
)

var procGetSaveFileName = comdlg32.NewProc("GetSaveFileNameW")

func showNativeQuestion(owner uintptr, title, text string) uintptr {
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	textPointer, _ := syscall.UTF16PtrFromString(text)
	result, _, _ := procMessageBox.Call(owner, uintptr(unsafe.Pointer(textPointer)), uintptr(unsafe.Pointer(titlePointer)), mbYesNo|mbIconWarn)
	return result
}

func saveDiagnosticsPath(owner uintptr) (string, bool, error) {
	filter := make([]uint16, 0, 96)
	for _, part := range []string{"JSON diagnostics package (*.json)", "*.json", "All files (*.*)", "*.*"} {
		for _, value := range part {
			filter = append(filter, uint16(value))
		}
		filter = append(filter, 0)
	}
	filter = append(filter, 0)
	extension, _ := syscall.UTF16PtrFromString("json")
	filename := make([]uint16, 32768)
	copy(filename, syscall.StringToUTF16("verselink-telemetry-diagnostics.json"))
	request := openFileName{
		StructSize:       uint32(unsafe.Sizeof(openFileName{})),
		Owner:            owner,
		Filter:           &filter[0],
		FilterIndex:      1,
		File:             &filename[0],
		MaxFile:          uint32(len(filename)),
		Title:            mustUTF16("Export VerseLink Telemetry diagnostics"),
		Flags:            ofnoverwriteprompt | ofnpathmustexist | ofnhideReadOnly | ofnnochangedir,
		DefaultExtension: extension,
	}
	result, _, _ := procGetSaveFileName.Call(uintptr(unsafe.Pointer(&request)))
	if result == 0 {
		code, _, _ := procCommonDialogError.Call()
		if code == 0 {
			return "", false, nil
		}
		return "", false, fmt.Errorf("save dialog failed with code %d", code)
	}
	path := syscall.UTF16ToString(filename)
	if path == "" {
		return "", false, fmt.Errorf("save dialog returned an empty path")
	}
	return path, true, nil
}
