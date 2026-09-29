package connection

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"reflect"
	"time"

	"github.com/compumark/verselink-telemetry/internal/revision"
	"github.com/compumark/verselink-telemetry/internal/telemetry"
)

type PresenceConfig struct {
	BaseURL, DeviceID string
	AllowHTTP         bool
	RevisionLock      *revision.Lock
}

type PresenceSnapshot struct {
	State     telemetry.TelemetryState
	Available bool
}

type PresenceMonitor struct {
	Client Client
	Store  CredentialStore
	Jitter func(time.Duration) time.Duration
}

func (m PresenceMonitor) Run(ctx context.Context, initial PresenceConfig, updates <-chan PresenceConfig, snapshots <-chan PresenceSnapshot) {
	config := initial
	var latest *PresenceRequest
	for {
		if config.DeviceID == "" || config.BaseURL == "" || config.RevisionLock == nil {
			select {
			case <-ctx.Done():
				return
			case next, ok := <-updates:
				if !ok {
					return
				}
				config = next
			case snapshot, ok := <-snapshots:
				if !ok {
					return
				}
				value := MapPresenceSnapshot(snapshot.State, snapshot.Available)
				latest = &value
			}
			continue
		}
		next, changed, stopped := m.runConfigured(ctx, config, updates, snapshots, &latest)
		if stopped {
			return
		}
		if changed {
			config = next
		}
	}
}

func (m PresenceMonitor) runConfigured(ctx context.Context, config PresenceConfig, updates <-chan PresenceConfig, snapshots <-chan PresenceSnapshot, latest **PresenceRequest) (PresenceConfig, bool, bool) {
	var sent *PresenceRequest
	var pending *PresenceRequest
	blocked := false
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return PresenceConfig{}, false, true
		}
		if !blocked && pending == nil && *latest != nil && !samePresence(sent, *latest) {
			if config.RevisionLock == nil {
				blocked = true
				continue
			}
			rev, err := config.RevisionLock.Advance()
			if err != nil {
				blocked = true
				continue
			}
			copy := **latest
			copy.Revision = rev.Revision
			pending = &copy
		}
		if pending == nil || blocked {
			select {
			case <-ctx.Done():
				return PresenceConfig{}, false, true
			case next, ok := <-updates:
				if !ok {
					return PresenceConfig{}, false, true
				}
				return next, true, false
			case snapshot, ok := <-snapshots:
				if !ok {
					return PresenceConfig{}, false, true
				}
				value := MapPresenceSnapshot(snapshot.State, snapshot.Available)
				*latest = &value
			}
			continue
		}
		requestCtx, cancel := context.WithCancel(ctx)
		type result struct {
			response PresenceResponse
			err      error
		}
		resultCh := make(chan result, 1)
		request := *pending
		go func() {
			if m.Store == nil {
				resultCh <- result{err: ErrInvalidCredential}
				return
			}
			credential, err := m.Store.Read(CredentialTarget(config.BaseURL, config.DeviceID))
			if err != nil || len(credential) == 0 {
				clear(credential)
				resultCh <- result{err: ErrInvalidCredential}
				return
			}
			client := m.Client
			client.BaseURL, client.AllowHTTP = config.BaseURL, config.AllowHTTP
			response, err := client.PutPresence(requestCtx, credential, request)
			resultCh <- result{response: response, err: err}
		}()
		var completed result
		select {
		case <-ctx.Done():
			cancel()
			<-resultCh
			return PresenceConfig{}, false, true
		case next, ok := <-updates:
			cancel()
			<-resultCh
			if !ok {
				return PresenceConfig{}, false, true
			}
			return next, true, false
		case snapshot, ok := <-snapshots:
			if !ok {
				cancel()
				<-resultCh
				return PresenceConfig{}, false, true
			}
			value := MapPresenceSnapshot(snapshot.State, snapshot.Available)
			*latest = &value
			select {
			case completed = <-resultCh:
			case <-ctx.Done():
				cancel()
				<-resultCh
				return PresenceConfig{}, false, true
			case next, ok := <-updates:
				cancel()
				<-resultCh
				if !ok {
					return PresenceConfig{}, false, true
				}
				return next, true, false
			}
		case completed = <-resultCh:
		}
		cancel()
		if completed.err == nil {
			semantic := request
			semantic.Revision = 0
			sent = &semantic
			pending = nil
			backoff = time.Second
			continue
		}
		var apiErr *APIError
		if errors.As(completed.err, &apiErr) && (apiErr.Code == "stale_revision" || apiErr.Code == "revision_conflict") {
			if apiErr.CurrentRevision < 1 || apiErr.CurrentRevision >= revision.MaxValue {
				blocked = true
				pending = nil
				continue
			}
			next, err := config.RevisionLock.AdvanceAtLeast(apiErr.CurrentRevision)
			if err != nil {
				blocked = true
				pending = nil
				continue
			}
			copy := **latest
			copy.Revision = next.Revision
			pending = &copy
			continue
		}
		if errors.Is(completed.err, ErrInvalidCredential) || errors.Is(completed.err, ErrInvalidURL) || errors.As(completed.err, &apiErr) && (apiErr.HTTPStatus == http.StatusUnauthorized || apiErr.HTTPStatus == http.StatusForbidden || apiErr.HTTPStatus >= 400 && apiErr.HTTPStatus < 500 && apiErr.HTTPStatus != http.StatusTooManyRequests) {
			blocked = true
			pending = nil
			continue
		}
		delay := time.Duration(0)
		if errors.As(completed.err, &apiErr) && apiErr.HTTPStatus == http.StatusTooManyRequests {
			delay = apiErr.RetryAfter
			if delay < time.Second {
				delay = time.Second
			}
			if delay > RetryAfterCap {
				delay = RetryAfterCap
			}
		} else if errors.As(completed.err, &apiErr) && apiErr.RetryAfter > 0 {
			delay = apiErr.RetryAfter
			if delay < time.Second {
				delay = time.Second
			}
			if delay > RetryAfterCap {
				delay = RetryAfterCap
			}
		}
		if delay <= 0 {
			if m.Jitter != nil {
				delay = m.Jitter(backoff)
				if delay < 0 {
					delay = 0
				}
				if delay > backoff {
					delay = backoff
				}
			} else {
				delay = time.Duration(rand.Int64N(int64(backoff) + 1))
			}
		}
		timer := time.NewTimer(delay)
		waiting := true
		for waiting {
			select {
			case <-ctx.Done():
				timer.Stop()
				return PresenceConfig{}, false, true
			case next, ok := <-updates:
				timer.Stop()
				if !ok {
					return PresenceConfig{}, false, true
				}
				return next, true, false
			case snapshot, ok := <-snapshots:
				if !ok {
					timer.Stop()
					return PresenceConfig{}, false, true
				}
				value := MapPresenceSnapshot(snapshot.State, snapshot.Available)
				*latest = &value
			case <-timer.C:
				waiting = false
			}
		}
		if backoff < BackoffCap {
			backoff *= 2
			if backoff > BackoffCap {
				backoff = BackoffCap
			}
		}
	}
}

func samePresence(left, right *PresenceRequest) bool {
	if left == nil || right == nil {
		return false
	}
	a, b := *left, *right
	// shard and party_count are wire-validated telemetry fields, but C1 excludes
	// them from persistence, derivation, and meaningful snapshot comparison.
	a.Revision, b.Revision = 0, 0
	a.Shard, b.Shard = nil, nil
	a.PartyCount, b.PartyCount = nil, nil
	return reflect.DeepEqual(a, b)
}
