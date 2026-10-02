//go:build windows

package main

import "testing"

func TestEmbeddedVerseLinkIconCanBeLoaded(t *testing.T) {
	instance, _, err := procGetModuleHandle.Call(0)
	if instance == 0 {
		t.Fatalf("GetModuleHandleW failed: %v", err)
	}
	icon, _, err := procLoadImage.Call(instance, appIconResource, imageIcon, 0, 0, lrDefaultSize|lrShared)
	if icon == 0 {
		t.Fatalf("LoadImageW could not load embedded VerseLink icon: %v", err)
	}
}
