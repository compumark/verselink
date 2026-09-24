package gamelog

import (
	"errors"
	"io"
	"strings"
	"testing"
)

type validationFileSystem struct {
	regular bool
	statErr error
	openErr error
}

func (f validationFileSystem) ReadFile(string) ([]byte, error) { return nil, errors.New("unused") }
func (f validationFileSystem) ReadDir(string) ([]DirectoryEntry, error) {
	return nil, errors.New("unused")
}
func (f validationFileSystem) IsRegular(string) (bool, error) { return f.regular, f.statErr }
func (f validationFileSystem) OpenRead(string) (io.Closer, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	return io.NopCloser(strings.NewReader("")), nil
}

func TestValidateGameLogPath(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
		fs   FileSystem
		want bool
	}{
		{"valid", `C:\manual\Game.log`, validationFileSystem{regular: true}, true},
		{"directory", `C:\manual\Game.log`, validationFileSystem{}, false},
		{"missing", `C:\manual\Game.log`, validationFileSystem{statErr: errors.New("missing")}, false},
		{"unreadable", `C:\manual\Game.log`, validationFileSystem{regular: true, openErr: errors.New("access denied")}, false},
		{"wrong name", `C:\manual\other.log`, validationFileSystem{regular: true}, false},
		{"blank", "  ", validationFileSystem{regular: true}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateGameLogPath(test.path, test.fs)
			if (err == nil) != test.want {
				t.Fatalf("ValidateGameLogPath() error = %v, want valid=%t", err, test.want)
			}
		})
	}
}
