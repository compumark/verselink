//go:build windows

package main

import "testing"

func TestCommonDialogCancellationIsNotAnError(t *testing.T) {
	if err := commonDialogFailure(0); err != nil {
		t.Fatalf("canceled file dialog returned error: %v", err)
	}
	if err := commonDialogFailure(0x3002); err == nil {
		t.Fatal("extended common-dialog error was ignored")
	}
}
