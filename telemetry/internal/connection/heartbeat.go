package connection

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http"
	"time"
)

const (
	HeartbeatInterval = 30 * time.Second
	BackoffCap        = 60 * time.Second
	RetryAfterCap     = 300 * time.Second
)

type HealthState string

const (
	HealthNotConnected         HealthState = "Not connected"
	HealthConnecting           HealthState = "Connecting"
	HealthConnected            HealthState = "Connected"
	HealthTemporarilyOffline   HealthState = "Temporarily offline"
	HealthAuthenticationFailed HealthState = "Authentication failed"
	HealthDeviceRevoked        HealthState = "Device revoked"
)

type HeartbeatConfig struct {
	BaseURL, DeviceID string
	AllowHTTP         bool
}

type HealthStatus struct {
	State       HealthState
	DeviceID    string
	LastSuccess time.Time
	Error       string // safe category only; never contains HTTP/body/header data
}

type HealthObserver interface{ OnConnectionHealth(HealthStatus) }

type HeartbeatMonitor struct {
	Client Client
	Store  CredentialStore
	Wait   func(context.Context, time.Duration) bool
	Jitter func(time.Duration) time.Duration
}

func (m HeartbeatMonitor) delay(ctx context.Context, duration time.Duration) bool {
	if m.Wait != nil {
		return m.Wait(ctx, duration)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (m HeartbeatMonitor) jitter(cap time.Duration) time.Duration {
	if m.Jitter != nil {
		value := m.Jitter(cap)
		if value < 0 {
			return 0
		}
		if value > cap {
			return cap
		}
		return value
	}
	if cap <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(cap) + 1))
}

// Run sends immediately on configuration, then every 30 seconds after success.
// A configuration update (pair/disconnect) cancels both in-flight requests and
// any wait. Terminal auth/protocol errors remain quiet until a config changes.
func (m HeartbeatMonitor) Run(ctx context.Context, initial HeartbeatConfig, updates <-chan HeartbeatConfig, observer HealthObserver) {
	config := initial
	for {
		if config.DeviceID == "" || config.BaseURL == "" {
			emitHealth(observer, HealthStatus{State: HealthNotConnected})
			select {
			case <-ctx.Done():
				return
			case next, ok := <-updates:
				if !ok {
					return
				}
				config = next
			}
			continue
		}
		configCtx, cancel := context.WithCancel(ctx)
		status := HealthStatus{State: HealthConnecting, DeviceID: config.DeviceID}
		emitHealth(observer, status)
		next, changed, stopped := m.runDevice(configCtx, config, updates, observer, status)
		cancel()
		if stopped {
			return
		}
		if changed {
			config = next
		}
	}
}

func (m HeartbeatMonitor) runDevice(ctx context.Context, config HeartbeatConfig, updates <-chan HeartbeatConfig, observer HealthObserver, status HealthStatus) (HeartbeatConfig, bool, bool) {
	requestCtx, cancel := context.WithCancel(ctx)
	type update struct {
		config HeartbeatConfig
		closed bool
	}
	updateCh := make(chan update, 1)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-requestCtx.Done():
		case next, ok := <-updates:
			updateCh <- update{config: next, closed: !ok}
			cancel()
		}
	}()
	defer func() { cancel(); <-watchDone }()
	waitChange := func() (HeartbeatConfig, bool, bool) {
		var change update
		select {
		case <-ctx.Done():
			cancel()
			<-watchDone
			return HeartbeatConfig{}, false, true
		case change = <-updateCh:
		}
		cancel()
		<-watchDone
		if ctx.Err() != nil {
			return HeartbeatConfig{}, false, true
		}
		if change.closed {
			return HeartbeatConfig{}, false, true
		}
		return change.config, true, false
	}
	backoff := time.Second
	for {
		if m.Store == nil {
			status.State, status.Error = HealthAuthenticationFailed, "credential_unavailable"
			emitHealth(observer, status)
			return waitChange()
		}
		target := CredentialTarget(config.BaseURL, config.DeviceID)
		credential, err := m.Store.Read(target)
		if err != nil || len(credential) == 0 {
			clear(credential)
			status.State, status.Error = HealthAuthenticationFailed, "credential_unavailable"
			emitHealth(observer, status)
			return waitChange()
		}
		client := m.Client
		client.BaseURL, client.AllowHTTP = config.BaseURL, config.AllowHTTP
		response, requestErr := client.Heartbeat(requestCtx, credential)
		if requestCtx.Err() != nil {
			if ctx.Err() != nil {
				return HeartbeatConfig{}, false, true
			}
			return waitChange()
		}
		if errors.Is(requestErr, ErrInvalidCredential) {
			status.State, status.Error = HealthAuthenticationFailed, "credential_unavailable"
			emitHealth(observer, status)
			return waitChange()
		}
		if requestErr == nil {
			status.State, status.Error, status.LastSuccess = HealthConnected, "", response.ReceivedAt
			emitHealth(observer, status)
			backoff = time.Second
			if !m.delay(requestCtx, HeartbeatInterval) {
				if ctx.Err() != nil {
					return HeartbeatConfig{}, false, true
				}
				return waitChange()
			}
			continue
		}
		var apiErr *APIError
		if errors.As(requestErr, &apiErr) {
			if apiErr.HTTPStatus == http.StatusUnauthorized {
				status.State, status.Error = HealthAuthenticationFailed, "invalid_device_credential"
				if apiErr.Code == "device_revoked" {
					status.State, status.Error = HealthDeviceRevoked, "device_revoked"
				}
				emitHealth(observer, status)
				return waitChange()
			}
			if apiErr.HTTPStatus == http.StatusForbidden {
				status.State, status.Error = HealthAuthenticationFailed, "account_inactive"
				emitHealth(observer, status)
				return waitChange()
			}
			if apiErr.HTTPStatus == http.StatusTooManyRequests {
				status.State, status.Error = HealthTemporarilyOffline, "rate_limited"
				emitHealth(observer, status)
				delay := apiErr.RetryAfter
				if delay < time.Second {
					delay = time.Second
				}
				if delay > RetryAfterCap {
					delay = RetryAfterCap
				}
				if !m.delay(requestCtx, delay) {
					if ctx.Err() != nil {
						return HeartbeatConfig{}, false, true
					}
					return waitChange()
				}
				continue
			}
			if apiErr.HTTPStatus < 500 {
				status.State, status.Error = HealthTemporarilyOffline, "client_error"
				emitHealth(observer, status)
				return waitChange()
			}
		}
		if errors.Is(requestErr, ErrInvalidResponse) {
			status.State, status.Error = HealthTemporarilyOffline, "invalid_response"
			emitHealth(observer, status)
			return waitChange()
		}
		status.State, status.Error = HealthTemporarilyOffline, "server_unavailable"
		emitHealth(observer, status)
		delay := apiErrRetryAfter(requestErr)
		if delay == 0 {
			delay = m.jitter(backoff)
		}
		if !m.delay(requestCtx, delay) {
			if ctx.Err() != nil {
				return HeartbeatConfig{}, false, true
			}
			return waitChange()
		}
		if backoff < BackoffCap {
			backoff *= 2
			if backoff > BackoffCap {
				backoff = BackoffCap
			}
		}
	}
}

func apiErrRetryAfter(err error) time.Duration {
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.HTTPStatus >= 500 && apiErr.RetryAfter > 0 {
		if apiErr.RetryAfter < time.Second {
			return time.Second
		}
		if apiErr.RetryAfter > RetryAfterCap {
			return RetryAfterCap
		}
		return apiErr.RetryAfter
	}
	return 0
}

func waitForConfig(ctx context.Context, updates <-chan HeartbeatConfig) (HeartbeatConfig, bool, bool) {
	select {
	case <-ctx.Done():
		return HeartbeatConfig{}, false, true
	case next, ok := <-updates:
		if !ok {
			return HeartbeatConfig{}, false, true
		}
		return next, true, false
	}
}

func emitHealth(observer HealthObserver, status HealthStatus) {
	if observer != nil {
		observer.OnConnectionHealth(status)
	}
}
