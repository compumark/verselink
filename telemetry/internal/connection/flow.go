package connection

import (
	"context"
	"errors"
)

type State string

const (
	NotConnected         State = "Not connected"
	Pairing              State = "Pairing"
	Connected            State = "Connected"
	AuthenticationFailed State = "Authentication failed"
	DeviceRevoked        State = "Device revoked"
	ServerUnavailable    State = "Server unavailable"
)

var ErrSecureStore = errors.New("secure credential storage failed; the server may already have created the pairing")

type CredentialStore interface {
	Read(target string) ([]byte, error)
	Write(target string, credential []byte) error
	Delete(target string) error
}

type PairingService struct {
	Client Client
	Store  CredentialStore
}

type Snapshot struct {
	State                         State
	DeviceID, DeviceName, Message string
}

type Controller struct {
	Service PairingService
	Current Snapshot
}

func (c *Controller) Pair(ctx context.Context, target, code, name string) (ClaimResponse, error) {
	c.Current = Snapshot{State: Pairing, Message: "Pairing in progress"}
	response, err := c.Service.Pair(ctx, target, code, name)
	if err != nil {
		state := NotConnected
		if errors.Is(err, ErrServerUnavailable) {
			state = ServerUnavailable
		}
		c.Current = Snapshot{State: state, Message: err.Error()}
		return ClaimResponse{}, err
	}
	c.Current = Snapshot{State: Connected, DeviceID: response.DeviceID, DeviceName: response.DeviceName, Message: "Paired locally; server authentication is not yet verified"}
	return response, nil
}

func (c *Controller) SetAuthenticationState(state State, message string) {
	if state != AuthenticationFailed && state != DeviceRevoked && state != ServerUnavailable && state != Connected && state != NotConnected {
		return
	}
	c.Current.State = state
	c.Current.Message = message
}

func (c *Controller) Disconnect(target string) error {
	if err := Disconnect(c.Service.Store, target); err != nil {
		return err
	}
	c.Current = Snapshot{State: NotConnected, Message: "Local credential removed; server-side device was not revoked"}
	return nil
}

// Pair claims once and persists the returned secret only through the OS secure-store adapter.
func (s PairingService) Pair(ctx context.Context, target, code, name string) (ClaimResponse, error) {
	if s.Store == nil {
		return ClaimResponse{}, ErrSecureStore
	}
	response, err := s.Client.Claim(ctx, code, name)
	if err != nil {
		return ClaimResponse{}, err
	}
	if err := s.Store.Write(target, response.DeviceCredential); err != nil {
		clear(response.DeviceCredential)
		response.DeviceCredential = nil
		return ClaimResponse{}, ErrSecureStore
	}
	clear(response.DeviceCredential)
	response.DeviceCredential = nil
	return response, nil
}

func Disconnect(store CredentialStore, target string) error {
	if store == nil {
		return ErrSecureStore
	}
	return store.Delete(target)
}
