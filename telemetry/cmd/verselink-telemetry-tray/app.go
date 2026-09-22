package main

import (
	"context"
	"fmt"
	"sync"

	"github.com/compumark/verselink-telemetry/internal/diagnostics"
	"github.com/compumark/verselink-telemetry/internal/runtimehost"
)

type statusStore struct {
	mu     sync.RWMutex
	status runtimehost.Status
	wake   func()
}

func (s *statusStore) OnRuntimeStatus(status runtimehost.Status) {
	status.Diagnostics = runtimehost.SafeDiagnostics(status.Diagnostics)
	s.mu.Lock()
	s.status = status
	wake := s.wake
	s.mu.Unlock()
	if wake != nil {
		wake()
	}
}

func (s *statusStore) SetWake(wake func()) {
	s.mu.Lock()
	s.wake = wake
	s.mu.Unlock()
}

func (s *statusStore) Current() runtimehost.Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	status := s.status
	status.Diagnostics = runtimehost.SafeDiagnostics(status.Diagnostics)
	return status
}

func statusText(status runtimehost.Status) string {
	if status.Message != "" {
		return status.Message
	}
	if status.Phase == "" {
		return "Starting"
	}
	return string(status.Phase)
}

func diagnosticsText(status runtimehost.Status) string {
	header := fmt.Sprintf("VerseLink Telemetry\n\nStatus: %s", statusText(status))
	if !status.HasDiagnostics {
		if status.Path != "" {
			return fmt.Sprintf("%s\nGame.log: %s", header, status.Path)
		}
		return header + "\n\nSession diagnostics are not available yet."
	}
	return fmt.Sprintf("%s\n\n%s", header, diagnostics.FormatSession(runtimehost.SafeDiagnostics(status.Diagnostics)))
}

type shutdownController struct {
	once   sync.Once
	cancel context.CancelFunc
	done   <-chan struct{}
}

func newShutdownController(cancel context.CancelFunc, done <-chan struct{}) *shutdownController {
	return &shutdownController{cancel: cancel, done: done}
}

func (s *shutdownController) Request(after func()) {
	s.once.Do(func() {
		s.cancel()
		go func() {
			<-s.done
			if after != nil {
				after()
			}
		}()
	})
}

func runTelemetry(ctx context.Context, observer runtimehost.Observer) error {
	return runtimehost.Run(ctx, runtimehost.Config{
		Observer:         observer,
		RetryUnavailable: true,
	})
}
