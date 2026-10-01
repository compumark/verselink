package diagnostics

import (
	"sync"
	"testing"
)

func TestLogBufferAllowsOnlyFixedCodesAndKeepsBoundedChronologicalRing(t *testing.T) {
	var buffer LogBuffer
	if !buffer.Record(SeverityInfo, LogAppStarted) {
		t.Fatal("known event rejected")
	}
	if buffer.Record(SeverityInfo, LogEventCode("C:\\private\\Game.log RAW_SENTINEL")) {
		t.Fatal("unknown event accepted")
	}
	if buffer.Record(LogSeverity("token=SECRET_SENTINEL"), LogRuntimeWarning) {
		t.Fatal("unknown severity accepted")
	}
	for i := 1; i <= ApplicationLogCapacity+7; i++ {
		if !buffer.Record(SeverityWarning, LogAutostartError) {
			t.Fatal("known event rejected")
		}
	}
	entries := buffer.Snapshot()
	if len(entries) != ApplicationLogCapacity {
		t.Fatalf("entries=%d, capacity=%d", len(entries), ApplicationLogCapacity)
	}
	if entries[0].EventCode != LogAutostartError || entries[len(entries)-1].EventCode != LogAutostartError {
		t.Fatalf("ring order is not newest bounded window: first=%#v last=%#v", entries[0], entries[len(entries)-1])
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].Timestamp.Before(entries[i-1].Timestamp) {
			t.Fatalf("timestamps out of order at %d", i)
		}
	}
}

func TestLogBufferConcurrentRecordAndSnapshot(t *testing.T) {
	var buffer LogBuffer
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 100; j++ {
				buffer.Record(SeverityInfo, LogRuntimeSearching)
				_ = buffer.Snapshot()
			}
		}()
	}
	workers.Wait()
	if got := len(buffer.Snapshot()); got != ApplicationLogCapacity {
		t.Fatalf("entries=%d, capacity=%d", got, ApplicationLogCapacity)
	}
}
