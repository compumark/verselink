//go:build !windows

package main

import "fmt"

func main() {
	fmt.Println("VerseLink Telemetry tray is available on Windows only")
}
