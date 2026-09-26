//go:build !windows

package connection

import "errors"

var ErrCredentialStoreUnavailable = errors.New("Windows Credential Manager is unavailable on this platform")

type SystemCredentialStore struct{}

func (SystemCredentialStore) Read(string) ([]byte, error) { return nil, ErrCredentialStoreUnavailable }
func (SystemCredentialStore) Write(string, []byte) error  { return ErrCredentialStoreUnavailable }
func (SystemCredentialStore) Delete(string) error         { return ErrCredentialStoreUnavailable }
