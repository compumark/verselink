//go:build windows

package connection

import (
	"errors"
	"testing"
)

type fakeCredentialAPI struct {
	values map[string][]byte
	err    error
}

func (f *fakeCredentialAPI) write(k string, v []byte) error {
	if f.err != nil {
		return f.err
	}
	f.values[k] = append([]byte(nil), v...)
	return nil
}
func (f *fakeCredentialAPI) read(k string) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	return append([]byte(nil), f.values[k]...), nil
}
func (f *fakeCredentialAPI) delete(k string) error {
	if f.err != nil {
		return f.err
	}
	delete(f.values, k)
	return nil
}

func TestSystemCredentialStoreAdapterUsesOnlyInjectedFake(t *testing.T) {
	fake := &fakeCredentialAPI{values: map[string][]byte{}}
	store := SystemCredentialStore{api: fake}
	secret := []byte("vlt_" + repeatByte('a', 42) + "w")
	if err := store.Write("target", secret); err != nil {
		t.Fatal(err)
	}
	read, err := store.Read("target")
	if err != nil || string(read) != string(secret) {
		t.Fatalf("read = %q, %v", read, err)
	}
	clear(read)
	if err := store.Delete("target"); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.values["target"]; ok {
		t.Fatal("fake credential was not deleted")
	}
	if _, err := store.Read("missing"); err != nil {
		t.Fatalf("missing credential must be normal: %v", err)
	}
}

func TestSystemCredentialStoreAdapterSurfacesOnlySafeErrors(t *testing.T) {
	fake := &fakeCredentialAPI{values: map[string][]byte{}, err: errors.New("secret-detail")}
	store := SystemCredentialStore{api: fake}
	if err := store.Write("target", []byte("vlt_"+repeatByte('a', 42)+"w")); err == nil || err.Error() == "secret-detail" {
		t.Fatalf("write error = %v", err)
	}
}

func repeatByte(value byte, count int) string {
	b := make([]byte, count)
	for i := range b {
		b[i] = value
	}
	return string(b)
}
