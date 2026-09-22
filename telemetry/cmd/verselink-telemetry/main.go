package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := Run(ctx, os.Stdout, RuntimeConfig{}); err != nil {
		fmt.Fprintln(os.Stderr, "VerseLink Telemetry runtime failed:", err)
		os.Exit(1)
	}
}
