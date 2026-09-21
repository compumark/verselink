package main

import (
	"fmt"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
)

func main() {
	fmt.Println(diagnostics.Banner(diagnostics.BuildMetadata{}))
}
